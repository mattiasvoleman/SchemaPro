import { randomUUID } from 'node:crypto';
import { highSchoolDocument, smallSchoolDocument } from './__fixtures__/documents';
import { parseCsv, writeCsv } from './csv';
import { MAX_EXCHANGE_LESSONS, type ExchangeDocument, type ExchangeLesson } from './exchange-model';
import * as fileSafety from './file-safety';
import { MAX_PROBLEMS } from './file-safety';
import { LESSON_TABLE_HEADER, LESSON_TABLE_HEADER_EN, lessonsToTable, normalizeHeader, tableToLessons } from './lesson-table';
import { readXlsx, writeXlsx } from './xlsx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A table row built from header -> value; every column not named is empty, the required ones default to a valid lesson. */
const DEFAULTS: Record<string, string> = { 'Klass/grupp': '7A', Ämne: 'Matematik', Dag: 'Mån', Start: '08:10', Slut: '09:10' };
function row(values: Record<string, string> = {}): string[] {
  const merged = { ...DEFAULTS, ...values };
  return LESSON_TABLE_HEADER.map((header) => merged[header] ?? '');
}
const table = (...rows: string[][]): string[][] => [[...LESSON_TABLE_HEADER], ...rows];

/** Reads a table that is expected to be fine and returns its single lesson. */
function readOne(values: Record<string, string>): ExchangeLesson {
  const parsed = tableToLessons(table(row(values)));
  expect(parsed.problems).toEqual([]);
  expect(parsed.lessons).toHaveLength(1);
  return parsed.lessons[0]!;
}

function problemsOf(values: Record<string, string>): { code: string; message: string; ref: string }[] {
  const parsed = tableToLessons(table(row(values)));
  expect(parsed.lessons).toEqual([]);
  return parsed.problems;
}

/** Canonical text of a lesson with the reader's `ref` removed and keys in a fixed order. */
function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sorted(x)]))
        : v;
  return JSON.stringify(sorted(value));
}
const multiset = (lessons: ExchangeLesson[]): string[] => lessons.map((lesson) => canonical({ ...lesson, ref: '' })).sort();

/** The fixture with ids on everything that can carry one. */
function withIds(doc: ExchangeDocument): ExchangeDocument {
  return {
    ...doc,
    lessons: doc.lessons.map((lesson, index) => ({
      ...lesson,
      teachers: lesson.teachers.map((teacher) => ({ ...teacher, id: `usr-${teacher.short}` })),
      ids: {
        lesson: `les-${index}`,
        group: `grp-${lesson.group}`,
        ...(lesson.extraGroups.length > 0 ? { extraGroups: lesson.extraGroups.map((name) => `grp-${name}`) } : {}),
        subject: `sub-${lesson.subject}`,
        ...(lesson.room !== null ? { room: `room-${lesson.room}` } : {}),
      },
    })),
  };
}

const FIXTURES: [string, () => ExchangeDocument][] = [
  ['the small school', smallSchoolDocument],
  ['the high school', highSchoolDocument],
  ['the small school, with ids', () => withIds(smallSchoolDocument())],
  ['the high school, with ids', () => withIds(highSchoolDocument())],
];

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('the columns', () => {
  it('are the twenty-eight of the contract, in order, in Swedish and in English', () => {
    expect(LESSON_TABLE_HEADER).toEqual([
      'Lektions-id', 'Klass/grupp', 'Grupp-id', 'Ytterligare klasser', 'Ytterligare klass-id', 'Ämne', 'Ämneskod', 'Ämnes-id',
      'Lärare', 'Lärarnamn', 'Lärare e-post', 'Lärar-id', 'Medlärare', 'Medlärarnamn', 'Medlärare e-post', 'Medlärar-id',
      'Sal', 'Sal-id', 'Dag', 'Start', 'Slut', 'Längd', 'Period', 'Från', 'Till', 'Veckomönster', 'Block', 'Låst',
    ]);
    expect(LESSON_TABLE_HEADER_EN).toEqual([
      'Lesson id', 'Class/group', 'Group id', 'Additional classes', 'Additional class ids', 'Subject', 'Subject code', 'Subject id',
      'Teacher', 'Teacher name', 'Teacher e-mail', 'Teacher id', 'Co-teacher', 'Co-teacher name', 'Co-teacher e-mail', 'Co-teacher id',
      'Room', 'Room id', 'Day', 'Start', 'End', 'Length (min)', 'Period', 'From', 'To', 'Week pattern', 'Block', 'Locked',
    ]);
  });

  it('read back from the English header, each to its own field', () => {
    const english = [...LESSON_TABLE_HEADER_EN];
    const values = LESSON_TABLE_HEADER.map((_header, index) => `v${index}`);
    // Make the cells that must be valid valid, and every other cell a distinct text.
    const set = (header: string, value: string): void => {
      values[english.indexOf(header)] = value;
    };
    set('Class/group', '7A'); set('Subject', 'Matematik'); set('Day', 'Tue'); set('Start', '08:10'); set('End', '09:10');
    set('Length (min)', '60'); set('From', '2026-08-17'); set('To', '2026-12-18'); set('Week pattern', 'A');
    const parsed = tableToLessons([english, values]);
    expect(parsed.problems).toEqual([]);
    expect(canonical({ ...parsed.lessons[0], ref: '' })).toBe(
      canonical({
        ref: '', group: '7A', extraGroups: ['v3'], subject: 'Matematik', subjectCode: 'v6',
        teachers: [{ short: 'v8', name: 'v9', email: 'v10', id: 'v11' }, { short: 'v12', name: 'v13', email: 'v14', id: 'v15' }],
        room: 'v16', day: 2, start: '08:10', end: '09:10', weeks: 'ODD', from: '2026-08-17', to: '2026-12-18', block: 'v26',
        ids: { lesson: 'v0', group: 'v2', extraGroups: ['v4'], subject: 'v7', room: 'v17' },
      }),
    );
  });

  it('accept the aliases, in any case and spelling', () => {
    const header = ['LÄRARE SIGNATUR', 'klass / grupp', 'AMNE', 'dag', 'start', 'SLUT', 'Medlarare  Signatur', 'veckor', 'langd (min)', 'Lärare e-post', 'LARARE E POST'];
    const parsed = tableToLessons([header, ['ABE', '7A', 'Matematik', 'Mån', '08:10', '09:10', 'BLU', 'B', '60', 'a@x.se', 'b@x.se']]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons[0]).toMatchObject({
      teachers: [{ short: 'ABE', email: 'a@x.se' }, { short: 'BLU' }],
      weeks: 'EVEN',
    });
    // The second "Lärare e-post" spelling is a duplicate of the first and is said so once.
    expect(parsed.notes).toEqual(['Kolumnen LARARE E POST finns flera gånger; den första används.']);
    expect(['Lärare', 'Signatur', 'Teacher signature'].map((name) => tableToLessons([[name, 'Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut'], ['ABE', '7A', 'Ma', '1', '8:00', '9:00']]).lessons[0]?.teachers[0]?.short)).toEqual(['ABE', 'ABE', 'ABE']);
  });

  it('normalise headers the way the web does: case, space, punctuation and diacritics do not matter', () => {
    expect(normalizeHeader('Lärare e-post')).toBe('larareepost');
    expect(normalizeHeader(' LARARE  E_POST ')).toBe('larareepost');
    expect(normalizeHeader('Längd (min)')).toBe('langdmin');
  });
});

describe('lessonsToTable', () => {
  const small = lessonsToTable(smallSchoolDocument());
  const high = lessonsToTable(highSchoolDocument());

  it('writes the Swedish header and one row per lesson, every row as wide as the header', () => {
    expect(small[0]).toEqual([...LESSON_TABLE_HEADER]);
    expect(small).toHaveLength(1 + 7);
    expect(high).toHaveLength(1 + 19);
    for (const r of [...small, ...high]) expect(r).toHaveLength(28);
  });

  it('sorts by group in natural order, then day, start, subject and teacher', () => {
    expect(small.slice(1).map((r) => r.slice(1, 2).concat(r.slice(18, 20), r.slice(5, 6)).join(' '))).toEqual([
      '1A Mån 08:30 Matematik',
      '1A Mån 09:30 Svenska',
      '1A Ons 08:30 Matematik',
      '1A Tors 10:30 Idrott och hälsa',
      '2A Mån 08:30 Matematik',
      '2A Tis 08:30 Svenska',
      '2A Tors 08:30 Idrott och hälsa',
    ]);
    expect([...new Set(high.slice(1).map((r) => r[1]))]).toEqual(['7A', '7A-1', '7A-2', '7B', '8A', '8B', 'Fr7', 'Sp7', 'Ty7']);
  });

  it('breaks a tie between two lessons of one group at the same time by subject, then teacher', () => {
    const doc = smallSchoolDocument();
    const [base] = doc.lessons;
    const at = (subject: string, short: string | null, name: string | null): ExchangeLesson => ({
      ...base!, subject, teachers: [{ short, name, email: null, id: null }],
    });
    doc.lessons = [at('Svenska', 'Z', null), at('Matematik', 'B', null), at('Matematik', null, 'Anna'), at('Matematik', null, null), { ...at('Matematik', 'A', null), teachers: [] }, at('Matematik', 'A', null)];
    const rows = lessonsToTable(doc).slice(1).map((r) => `${r[5]}/${r[8]}/${r[9]}`);
    expect(rows).toEqual(['Matematik//', 'Matematik//', 'Matematik/A/', 'Matematik//Anna', 'Matematik/B/', 'Svenska/Z/']);
  });

  it('writes a lesson in full: names, codes, teachers, room, day, times, length, period, weeks, block, locked', () => {
    expect(small[1]).toEqual(['', '1A', '', '', '', 'Matematik', 'MA', '', 'ABE', 'Anna Berg', 'anna.berg@skolan.example', '', '', '', '', '', 'Klassrum 1', '', 'Mån', '08:30', '09:15', '45', 'Hela läsåret', '', '', '', '', 'Ja']);
    const coTaught = high.find((r) => r[1] === '8A' && r[5] === 'Idrott och hälsa')!;
    expect(coTaught).toEqual(['', '8A', '', '', '', 'Idrott och hälsa', 'IDH', '', 'EST', 'Eva Strand', 'eva.strand@skolan.example', '', 'FAL', 'Farid Alm', 'farid.alm@skolan.example', '', 'Gymnastiksalen', '', 'Tors', '08:10', '09:40', '90', 'Hela läsåret', '', '', '', '', 'Ja']);
    const music = high.find((r) => r[1] === '8A' && r[5] === 'Musik')!;
    expect([music[3], music[9], music[10]]).toEqual(['8B', 'Dan Nord', '']);
    const alternating = high.find((r) => r[1] === '7A' && r[5] === 'Slöjd')!;
    expect([alternating[25], alternating[18], alternating[21]]).toEqual(['A', 'Tis', '80']);
    expect(high.find((r) => r[1] === '7B' && r[5] === 'Slöjd')![25]).toBe('B');
    const spring = high.find((r) => r[1] === '7A-1' && r[5] === 'Musik')!;
    expect([spring[22], spring[23], spring[24]]).toEqual(['2027-01-11–2027-06-11', '2027-01-11', '2027-06-11']);
    expect(high.find((r) => r[1] === 'Sp7')![26]).toBe('Språkval åk 7');
    const noRoom = high.find((r) => r[1] === '8B' && r[5] === 'Engelska')!;
    expect([noRoom[8], noRoom[16]]).toEqual(['', '']);
  });

  it('writes ids beside names, the extra groups and their ids as " | " lists in the same order, and leaves the id cell empty when none has one', () => {
    const doc = highSchoolDocument();
    const music = doc.lessons.find((l) => l.subject === 'Musik' && l.group === '8A')!;
    music.extraGroups = ['8B', '7A', '7B'];
    music.ids = { lesson: 'l1', group: 'g8A', extraGroups: ['g8B', null, 'g7B'], subject: 's', room: 'r' };
    music.teachers = [{ ...music.teachers[0]!, id: 'u1' }];
    let r = lessonsToTable(doc).find((x) => x[0] === 'l1')!;
    expect([r[0], r[2], r[3], r[4], r[7], r[11], r[17]]).toEqual(['l1', 'g8A', '8B | 7A | 7B', 'g8B |  | g7B', 's', 'u1', 'r']);
    music.ids = { lesson: 'l1' };
    r = lessonsToTable(doc).find((x) => x[0] === 'l1')!;
    expect([r[3], r[4]]).toEqual(['8B | 7A | 7B', '']);
  });

  it('writes a day outside 1-7 as its number, a period with one end open, and no length for a time it cannot read', () => {
    const doc = smallSchoolDocument();
    doc.lessons = [
      { ...doc.lessons[0]!, day: 9, from: '2026-08-17', to: null },
      { ...doc.lessons[1]!, day: 0, from: null, to: '2027-01-01', start: 'tidigt' },
    ];
    const rows = lessonsToTable(doc).slice(1);
    expect(rows.map((r) => [r[18], r[21], r[22]])).toEqual([
      ['0', '', '–2027-01-01'],
      ['9', '45', '2026-08-17–'],
    ]);
  });

  it('puts a lesson whose start cannot be read before the others of its day, in either order of input', () => {
    const doc = smallSchoolDocument();
    const [base] = doc.lessons;
    const at = (start: string, subject: string): ExchangeLesson => ({ ...base!, start, subject });
    for (const input of [
      [at('08:30', 'A'), at('tidigt', 'B'), at('08:00', 'C')],
      [at('tidigt', 'B'), at('08:30', 'A'), at('08:00', 'C')],
      [at('08:00', 'C'), at('08:30', 'A'), at('tidigt', 'B')],
    ]) {
      doc.lessons = input;
      expect(lessonsToTable(doc).slice(1).map((r) => r[5])).toEqual(['B', 'C', 'A']);
    }
  });

  it('writes at most the lead and the co-teacher', () => {
    const doc = smallSchoolDocument();
    const three = [...doc.teachers, { short: 'CCC', name: 'Tredje', email: null, id: null }];
    doc.lessons = [{ ...doc.lessons[0]!, teachers: three }];
    const r = lessonsToTable(doc)[1]!;
    expect([r[8], r[12]]).toEqual(['ABE', 'BLU']);
    expect(r).not.toContain('CCC');
  });
});

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

describe('the round trip: what is written is read back, every field, as a multiset', () => {
  describe.each(FIXTURES)('%s', (_name, build) => {
    const doc = build();
    const rows = lessonsToTable(doc);

    it.each([[';' as const], [',' as const]])('through CSV with %s', (delimiter) => {
      const parsed = parseCsv(writeCsv(rows, { delimiter }));
      expect(parsed.delimiter).toBe(delimiter);
      const result = tableToLessons(parsed.rows, parsed.rowNumbers);
      expect(result.problems).toEqual([]);
      expect(result.notes).toEqual([]);
      expect(multiset(result.lessons)).toEqual(multiset(doc.lessons));
    });

    it('through tab-separated text', () => {
      const text = rows.map((r) => r.join('\t')).join('\n');
      const parsed = parseCsv(text);
      expect(parsed.delimiter).toBe('\t');
      const result = tableToLessons(parsed.rows, parsed.rowNumbers);
      expect(result.problems).toEqual([]);
      expect(multiset(result.lessons)).toEqual(multiset(doc.lessons));
    });

    it('through Excel', () => {
      const result = tableToLessons(readXlsx(writeXlsx(rows, { sheetName: 'Schema', frozenHeader: true })).rows);
      expect(result.problems).toEqual([]);
      expect(result.notes).toEqual([]);
      expect(multiset(result.lessons)).toEqual(multiset(doc.lessons));
    });

    it('names each lesson by the row it is on, as Excel shows it', () => {
      const result = tableToLessons(readXlsx(writeXlsx(rows, { sheetName: 'Schema' })).rows);
      expect(result.lessons.map((lesson) => lesson.ref)).toEqual(rows.slice(1).map((_r, index) => `rad ${index + 2}`));
    });
  });

  it('keeps lessons that differ only in letter case apart: that is the service\'s to resolve', () => {
    const doc = smallSchoolDocument();
    doc.lessons = [
      { ...doc.lessons[0]!, group: '7a', subject: 'matematik', room: 'a101' },
      { ...doc.lessons[0]!, group: '7A', subject: 'Matematik', room: 'A101' },
    ];
    const result = tableToLessons(parseCsv(writeCsv(lessonsToTable(doc))).rows);
    expect(result.lessons.map((l) => `${l.group}/${l.subject}/${l.room}`).sort()).toEqual(['7A/Matematik/A101', '7a/matematik/a101']);
  });

  it('survives a quoted cell with an embedded delimiter and line break', () => {
    const doc = highSchoolDocument();
    const sp = doc.lessons.find((l) => l.group === 'Sp7')!;
    sp.block = 'Språkval; åk 7\r\nandra raden, "citerad"';
    sp.room = 'A102;\nSal 2';
    for (const delimiter of [';', ','] as const) {
      const parsed = parseCsv(writeCsv(lessonsToTable(doc), { delimiter }));
      const result = tableToLessons(parsed.rows, parsed.rowNumbers);
      expect(result.problems).toEqual([]);
      expect(multiset(result.lessons)).toEqual(multiset(doc.lessons));
      // The lesson after the multi-line cells is still named by its Excel row.
      expect(result.lessons.map((l) => l.ref)).toEqual(lessonsToTable(doc).slice(1).map((_r, index) => `rad ${index + 2}`));
    }
  });

  it('survives names that a spreadsheet would run as formulas, through the CSV guard', () => {
    const doc = smallSchoolDocument();
    doc.lessons = [
      {
        ...doc.lessons[0]!,
        group: '=HYPERLINK("http://evil.example/")',
        subject: '+Matematik',
        room: '@SUM(A1)',
        block: '-block',
        teachers: [{ short: '=ABE', name: "=cmd|' /C calc'!A0", email: null, id: null }],
      },
    ];
    const csv = writeCsv(lessonsToTable(doc));
    // No cell starts with a trigger character: each has the apostrophe.
    const line = csv.slice(1).split('\r\n')[1]!;
    for (const guarded of ["'=HYPERLINK", "'+Matematik", "'@SUM(A1)", "'-block", "'=ABE", "'=cmd"]) expect(line).toContain(guarded);
    const result = tableToLessons(parseCsv(csv).rows);
    expect(result.problems).toEqual([]);
    expect(multiset(result.lessons)).toEqual(multiset(doc.lessons));
  });
});

// ---------------------------------------------------------------------------
// Finding the header
// ---------------------------------------------------------------------------

describe('tableToLessons: the header row', () => {
  const header = [...LESSON_TABLE_HEADER];

  it('skips title lines above the header and numbers rows as the user sees them', () => {
    const rows = [['Rastra schema'], ['Lillskolan', '', '', 'hösten 2026'], [], header, row(), row({ Start: 'sent' })];
    const parsed = tableToLessons(rows);
    expect(parsed.lessons.map((l) => l.ref)).toEqual(['rad 5']);
    expect(parsed.problems.map((p) => p.ref)).toEqual(['rad 6']);
  });

  it('takes the numbers parseCsv gives, so blank lines in a CSV do not move the lines after them', () => {
    const csv = ['Titel', '', header.join(';'), '', row().join(';'), '', '', row({ Dag: '9' }).join(';')].join('\n');
    const parsed = parseCsv(csv);
    const withNumbers = tableToLessons(parsed.rows, parsed.rowNumbers);
    expect(withNumbers.lessons.map((l) => l.ref)).toEqual(['rad 5']);
    expect(withNumbers.problems.map((p) => p.ref)).toEqual(['rad 8']);
    // Without them the blank lines are forgotten: that is why they are passed.
    expect(tableToLessons(parsed.rows).lessons.map((l) => l.ref)).toEqual(['rad 3']);
  });

  it('reads columns in any order and ignores extra ones, naming them once', () => {
    const rows = [
      ['Kommentar', 'Slut', 'Start', 'Dag', 'Ämne', 'Klass/grupp', 'Färg'],
      ['hej', '09:10', '08:10', 'Fre', 'Svenska', '9B', 'blå'],
    ];
    const parsed = tableToLessons(rows);
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons[0]).toMatchObject({ group: '9B', subject: 'Svenska', day: 5, start: '08:10', end: '09:10' });
    expect(parsed.notes).toEqual(['Kolumnerna Kommentar och Färg lästes inte: Rastra känner inte igen rubrikerna.']);
    expect(tableToLessons([[...rows[0]!.slice(0, 6), ''], rows[1]!]).notes).toEqual(['Kolumnen Kommentar lästes inte: Rastra känner inte igen rubriken.']);
    expect(tableToLessons([['A', 'B', 'C', ...rows[0]!.slice(1, 6)], ['1', '2', '3', ...rows[1]!.slice(1, 6)]]).notes).toEqual(['Kolumnerna A, B och C lästes inte: Rastra känner inte igen rubrikerna.']);
  });

  it('says once, for several, that a column is there more than once', () => {
    const rows = [['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut', 'Class/group', 'Subject', 'Day'], ['7A', 'Ma', 'Mån', '08:10', '09:10', 'X', 'Y', 'Z']];
    const parsed = tableToLessons(rows);
    expect(parsed.lessons[0]).toMatchObject({ group: '7A', subject: 'Ma', day: 1 });
    expect(parsed.notes).toEqual(['Kolumnerna Class/group, Subject och Day finns flera gånger; den första av varje används.']);
  });

  it('names the missing column, once, and reads no lessons', () => {
    const rows = [['Klass/grupp', 'Ämne', 'Dag', 'Start'], ['7A', 'Ma', 'Mån', '08:10']];
    const parsed = tableToLessons(rows);
    expect(parsed.lessons).toEqual([]);
    expect(parsed.problems).toEqual([
      { ref: 'rad 1', code: 'TABLE_MISSING_COLUMN', message: 'Kolumnen Slut saknas i tabellen. Rubrikraden ska ha Klass/grupp, Ämne, Dag, Start och Slut.' },
    ]);
  });

  it('names every missing column in the one problem, from the row that came closest', () => {
    const rows = [['Rubrik'], ['Annat', 'Mer'], ['Dag', 'Start', 'Foo'], ['Foo']];
    const parsed = tableToLessons(rows);
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatchObject({ ref: 'rad 3', code: 'TABLE_MISSING_COLUMN' });
    expect(parsed.problems[0]!.message).toMatch(/^Kolumnerna Klass\/grupp, Ämne och Slut saknas i tabellen\./);
  });

  it('refuses a file with no recognisable header, or no rows at all, the same way', () => {
    for (const rows of [[], [[]], [['a', 'b'], ['1', '2']]]) {
      const parsed = tableToLessons(rows);
      expect(parsed.lessons).toEqual([]);
      expect(parsed.problems).toHaveLength(1);
      expect(parsed.problems[0]).toMatchObject({ ref: 'rad 1', code: 'TABLE_MISSING_COLUMN' });
      expect(parsed.problems[0]!.message).toMatch(/^Kolumnerna Klass\/grupp, Ämne, Dag, Start och Slut saknas/);
    }
  });

  it('looks for the header in the first fifty rows only', () => {
    const late = [...Array.from({ length: 50 }, () => ['titel']), header, row()];
    expect(tableToLessons(late).problems[0]!.code).toBe('TABLE_MISSING_COLUMN');
    const inTime = [...Array.from({ length: 49 }, () => ['titel']), header, row()];
    expect(tableToLessons(inTime).lessons).toHaveLength(1);
  });

  it('reads a header with no data rows as no lessons and no problems', () => {
    expect(tableToLessons([header])).toEqual({ lessons: [], problems: [], notes: [] });
  });

  it('does not mind a data row shorter than the header, or a column with no name', () => {
    const header = [...LESSON_TABLE_HEADER.slice(0, 22), ''];
    const short = tableToLessons([header, row().slice(0, 20)]);
    expect(short.lessons).toEqual([]);
    expect(short.problems).toEqual([{ ref: 'rad 2', code: 'TABLE_MISSING_VALUE', message: 'Värde saknas i kolumnen Slut.' }]);
    expect(short.notes).toEqual([]);
    expect(tableToLessons([header, row().slice(0, 22)])).toMatchObject({ lessons: [{ group: '7A' }], problems: [], notes: [] });
  });
});

// ---------------------------------------------------------------------------
// Personnummer
// ---------------------------------------------------------------------------

describe('tableToLessons: personnummer are dropped unread', () => {
  const PNR = '19900101-1234';
  const LONG_PNR = '199001011234';

  it.each([
    'Personnummer',
    'PERSONNUMMER',
    'Pnr',
    'personnr',
    'Personal number',
    'SSN',
    'Civic number',
    'Samordningsnummer',
    'Social security number',
    'Elevens personnummer (ÅÅMMDD-XXXX)',
    'Lärarens personnummer',
  ])('%s: the column is not read, and only its header is named', (name) => {
    const header = ['Klass/grupp', 'Ämne', name, 'Dag', 'Start', 'Slut'];
    const parsed = tableToLessons([header, ['7A', 'Ma', PNR, 'Mån', '08:10', '09:10']]);
    expect(parsed.problems).toEqual([]);
    expect(parsed.notes).toEqual([`Kolumnen ${name} lästes inte: Rastra tar inte emot personnummer.`]);
    expect(parsed.lessons).toHaveLength(1);
    // The cell value of the dropped column is nowhere in the result.
    expect(JSON.stringify(parsed)).not.toMatch(/1990|1234/);
    expect(LONG_PNR).toHaveLength(12);
  });

  it('never echoes the value, not even in the problem of a row that is refused', () => {
    const header = ['Klass/grupp', 'Ämne', 'Personnummer', 'Dag', 'Start', 'Slut', 'Veckomönster'];
    const parsed = tableToLessons([header, ['', 'Ma', PNR, 'Mån', '08:10', '09:10', 'X'], ['7A', '', LONG_PNR, 'Sön', '10:00', '09:00', '']]);
    expect(parsed.lessons).toEqual([]);
    expect(parsed.problems.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(parsed)).not.toMatch(/1990|1234/);
  });

  it('drops several such columns and still reads the rest, even when only they have text in a row', () => {
    const header = ['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut', 'Personnummer', 'Samordningsnummer'];
    const parsed = tableToLessons([header, ['7A', 'Ma', 'Mån', '08:10', '09:10', PNR, LONG_PNR], ['', '', '', '', '', PNR, '']]);
    expect(parsed.notes).toEqual([
      'Kolumnen Personnummer lästes inte: Rastra tar inte emot personnummer.',
      'Kolumnen Samordningsnummer lästes inte: Rastra tar inte emot personnummer.',
    ]);
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.problems).toEqual([
      { ref: 'rad 3', code: 'TABLE_MISSING_VALUE', message: 'Värde saknas i kolumnerna Klass/grupp, Ämne, Dag, Start och Slut.' },
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/1990/);
  });

  it('does not take a word that merely contains ssn for a personnummer column', () => {
    const parsed = tableToLessons([['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut', 'Classnotes'], ['7A', 'Ma', 'Mån', '08:10', '09:10', 'x']]);
    expect(parsed.notes).toEqual(['Kolumnen Classnotes lästes inte: Rastra känner inte igen rubriken.']);
  });
});

// ---------------------------------------------------------------------------
// Personnummer in a cell
// ---------------------------------------------------------------------------

/** The ways a number turns up in a cell: whole, short, long, a samordningsnummer, inside a name, in parentheses, spaced. */
const NUMBERS: [string, string][] = [
  ['12 digits with a hyphen', '19800101-1234'],
  ['10 digits', '8001011234'],
  ['12 digits', '198001011234'],
  ['10 digits with a hyphen', '800101-1234'],
  ['a samordningsnummer', '19800181-1234'],
  ['inside a name', 'Anna Berg 19800101-1234'],
  ['in parentheses', '(800101-1234)'],
  ['with spaces round the hyphen', '19800101 - 1234'],
];
/** Any digit run of any of the numbers above: the date, the last four. */
const NUMBER_DIGITS = /1980|8001|1234/;

/** The columns the reader reads: every one but the derived Period and Låst. */
const READ_COLUMNS = LESSON_TABLE_HEADER.filter((header) => header !== 'Period' && header !== 'Låst');

describe('tableToLessons: a personnummer in a cell the reader reads makes the row unreadable', () => {
  const message = (...columns: string[]): string =>
    `${columns.length === 1 ? 'Kolumnen' : 'Kolumnerna'} ${columns.length < 2 ? columns[0] : `${columns.slice(0, -1).join(', ')} och ${columns[columns.length - 1]}`} innehåller något som liknar ett personnummer; raden läses inte. Rastra tar inte emot personnummer.`;

  it.each(READ_COLUMNS)('%s: no lesson, one problem that names the column and quotes nothing', (column) => {
    for (const [form, number] of NUMBERS) {
      const parsed = tableToLessons(table(row({ [column]: number })));
      expect({ form, lessons: parsed.lessons.length, problems: parsed.problems }).toEqual({
        form,
        lessons: 0,
        problems: [{ ref: 'rad 2', code: 'TABLE_PERSONAL_NUMBER', message: message(column) }],
      });
      expect(JSON.stringify(parsed)).not.toMatch(NUMBER_DIGITS);
    }
  });

  it.each(READ_COLUMNS)('%s: the same through a CSV file and through an Excel file', (column) => {
    for (const number of ['19800101-1234', 'Anna Berg 19800101-1234', '(800101-1234)']) {
      const rows = table(row({ [column]: number }));
      for (const read of [
        () => tableToLessons(parseCsv(writeCsv(rows)).rows, parseCsv(writeCsv(rows)).rowNumbers),
        () => tableToLessons(readXlsx(writeXlsx(rows, { sheetName: 'S' })).rows),
      ]) {
        const parsed = read();
        expect(parsed.lessons).toEqual([]);
        expect(parsed.problems).toEqual([{ ref: 'rad 2', code: 'TABLE_PERSONAL_NUMBER', message: message(column) }]);
        expect(JSON.stringify(parsed)).not.toMatch(NUMBER_DIGITS);
      }
    }
  });

  it('is decided before anything of the row is parsed: a bad day, a bad time and a co-teacher without a lead say nothing more', () => {
    const parsed = tableToLessons(table(row({ Dag: '19800101-1234', Start: '800101-1234', Slut: '198001011234', Medlärare: '8001011234', Veckomönstret: 'x' })));
    expect(parsed.problems).toEqual([
      { ref: 'rad 2', code: 'TABLE_PERSONAL_NUMBER', message: message('Medlärare', 'Dag', 'Start', 'Slut') },
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(NUMBER_DIGITS);
  });

  it('names every column that has one, in the order of the contract, in the one problem', () => {
    const parsed = tableToLessons(table(row({ Block: '19800101-1234', Lärare: 'Anna 800101-1234', Sal: '(198001011234)' })));
    expect(parsed.problems).toEqual([{ ref: 'rad 2', code: 'TABLE_PERSONAL_NUMBER', message: message('Lärare', 'Sal', 'Block') }]);
    expect(JSON.stringify(parsed)).not.toMatch(NUMBER_DIGITS);
  });

  it('refuses that row only: the rows around it are read, and keep their numbers', () => {
    const parsed = tableToLessons(table(row(), row({ 'Lärarnamn': 'Anna Berg 19800101-1234' }), row({ Ämne: 'Svenska' })));
    expect(parsed.lessons.map((lesson) => [lesson.ref, lesson.subject])).toEqual([['rad 2', 'Matematik'], ['rad 4', 'Svenska']]);
    expect(parsed.problems.map((problem) => [problem.ref, problem.code])).toEqual([['rad 3', 'TABLE_PERSONAL_NUMBER']]);
  });

  it('does not take for a personnummer what is not shaped like one', () => {
    for (const text of ['A101', '2026-08-17', '08:10', 'Rum 12', '19801301-1234', '8001011', '1980010112345', '19800101-12345']) {
      const parsed = tableToLessons(table(row({ Block: text })));
      expect({ text, problems: parsed.problems.map((problem) => problem.code) }).toEqual({ text, problems: [] });
    }
  });

  describe('the ids Rastra writes are not taken for numbers by chance', () => {
    // Random v4 UUIDs that have the shape of a personnummer: one in 721 does (416 of 300 000, measured).
    const SHAPED = ['2bf66f8e-e2e7-4e02-a99d-9501727348cd', '33372b62-0a99-43f1-b32c-dd5803823078', 'e932a14f-8594-474f-85b9-ac5901616400'];
    const ID_COLUMN_NAMES = ['Lektions-id', 'Grupp-id', 'Ämnes-id', 'Lärar-id', 'Medlärar-id', 'Sal-id'];

    it('are premises: each of these UUIDs has the shape', () => {
      for (const id of SHAPED) expect(fileSafety.hasPersonalNumber(id)).toBe(true);
    });

    it.each(ID_COLUMN_NAMES)('%s: a UUID is read, whatever it looks like', (column) => {
      for (const id of SHAPED) {
        const parsed = tableToLessons(table(row({ Lärare: 'ABE', [column]: id })));
        expect({ id, problems: parsed.problems }).toEqual({ id, problems: [] });
        expect(parsed.lessons).toHaveLength(1);
      }
    });

    it('a list of them in the extra class ids is read, empty places and all', () => {
      const parsed = tableToLessons(table(row({ 'Ytterligare klasser': '8B | 7C | 7D', 'Ytterligare klass-id': `${SHAPED[0]} |  | ${SHAPED[1]!.toUpperCase()}` })));
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons[0]!.ids.extraGroups).toEqual([SHAPED[0], null, SHAPED[1]!.toUpperCase()]);
    });

    it('reads back 3 000 random ones through the id columns with no problem at all', () => {
      const uuids = Array.from({ length: 500 * 6 }, () => randomUUID());
      const rows = Array.from({ length: 500 }, (_v, i) => {
        const [lesson, group, subject, teacher, co, room] = uuids.slice(i * 6, i * 6 + 6);
        return row({ 'Lektions-id': lesson!, 'Grupp-id': group!, 'Ämnes-id': subject!, Lärare: 'ABE', 'Lärar-id': teacher!, Medlärare: 'BLU', 'Medlärar-id': co!, 'Sal-id': room! });
      });
      const parsed = tableToLessons(table(...rows));
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons).toHaveLength(500);
      expect(parsed.lessons.map((lesson) => lesson.ids.lesson)).toEqual(rows.map((r) => r[0]));
    });

    it('takes a UUID-shaped cell whose tail is a twelve-digit personnummer for the id it is shaped like, and nothing else', () => {
      const tail = '00000000-0000-0000-0000-198001011234';
      expect(fileSafety.hasPersonalNumber(tail)).toBe(true);
      const parsed = tableToLessons(table(row({ 'Sal-id': tail })));
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons[0]!.ids.room).toBe(tail);
      // Not UUID-shaped: a letter after the tail, one group too many, a prefix, the number alone.
      for (const text of ['00000000-0000-0000-0000-198001011234x', '00000000-0000-0000-0000-0000-198001011234', 'id 00000000-0000-0000-0000-198001011234', '198001011234']) {
        const refused = tableToLessons(table(row({ 'Sal-id': text })));
        expect({ text, codes: refused.problems.map((problem) => problem.code) }).toEqual({ text, codes: ['TABLE_PERSONAL_NUMBER'] });
        expect(refused.problems[0]!.message).not.toMatch(NUMBER_DIGITS);
      }
    });

    it('is for the id columns only, and for nothing but ids in them', () => {
      const [shaped] = SHAPED;
      expect(tableToLessons(table(row({ Block: shaped! }))).problems.map((problem) => problem.code)).toEqual(['TABLE_PERSONAL_NUMBER']);
      expect(tableToLessons(table(row({ Lärare: shaped! }))).problems.map((problem) => problem.code)).toEqual(['TABLE_PERSONAL_NUMBER']);
      for (const text of [`${shaped} 19800101-1234`, `${shaped} | 19800101-1234`, `${shaped}x`, '19800101-1234', '8001011234', `${shaped.slice(1)}`]) {
        const parsed = tableToLessons(table(row({ 'Grupp-id': text })));
        expect({ text, codes: parsed.problems.map((problem) => problem.code), lessons: parsed.lessons.length }).toEqual({ text, codes: ['TABLE_PERSONAL_NUMBER'], lessons: 0 });
      }
    });
  });

  describe('a column that is not read does not make its row unreadable', () => {
    const PNR = '19800101-1234';

    it('a column whose header says personnummer, and a column nobody recognises', () => {
      const header = ['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut', 'Personnummer', 'Anteckning'];
      const parsed = tableToLessons([header, ['7A', 'Ma', 'Mån', '08:10', '09:10', PNR, `Ring ${PNR}`]]);
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons).toHaveLength(1);
      expect(parsed.notes).toEqual([
        'Kolumnen Personnummer lästes inte: Rastra tar inte emot personnummer.',
        'Kolumnen Anteckning lästes inte: Rastra känner inte igen rubriken.',
      ]);
      expect(JSON.stringify(parsed)).not.toMatch(NUMBER_DIGITS);
    });

    it('the second of two columns with one header (the first is the one that is used), and Period and Låst, which are derived', () => {
      const header = [...LESSON_TABLE_HEADER, 'Lärare'];
      const values = row({ Lärare: 'ABE', Period: PNR, Låst: `Ja ${PNR}` });
      const parsed = tableToLessons([header, [...values, PNR]]);
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons).toHaveLength(1);
      expect(parsed.lessons[0]!.teachers).toEqual([{ short: 'ABE', name: null, email: null, id: null }]);
      expect(parsed.notes).toEqual(['Kolumnen Lärare finns flera gånger; den första används.']);
      expect(JSON.stringify(parsed)).not.toMatch(NUMBER_DIGITS);
    });
  });

  describe('a header that is itself a personnummer is not read and is not named', () => {
    const required = ['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut'];
    const lesson = ['7A', 'Ma', 'Mån', '08:10', '09:10'];
    const NOTE = 'En kolumn vars rubrik liknar ett personnummer lästes inte: Rastra tar inte emot personnummer.';

    it.each(NUMBERS)('%s', (_form, number) => {
      const parsed = tableToLessons([[...required, number], [...lesson, number]]);
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons).toHaveLength(1);
      expect(parsed.notes).toEqual([NOTE]);
      expect(JSON.stringify(parsed)).not.toMatch(NUMBER_DIGITS);
    });

    it('also when the header goes on to say what it is, and is counted when there are several', () => {
      const one = tableToLessons([[...required, 'Personnummer 19800101-1234'], [...lesson, 'x']]);
      expect(one.notes).toEqual([NOTE]);
      const two = tableToLessons([[...required, 'Personnummer 19800101-1234', '800101-1234', 'Anteckning'], [...lesson, 'x', 'y', 'z']]);
      expect(two.notes).toEqual([
        '2 kolumner vars rubriker liknar personnummer lästes inte: Rastra tar inte emot personnummer.',
        'Kolumnen Anteckning lästes inte: Rastra känner inte igen rubriken.',
      ]);
      expect(JSON.stringify(two)).not.toMatch(NUMBER_DIGITS);
    });

    it('also in a title above the table, which is skipped without a word', () => {
      const parsed = tableToLessons([['Schema 19800101-1234'], [...required], [...lesson]]);
      expect(parsed.lessons).toHaveLength(1);
      expect(parsed.notes).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// What a message may quote, and how many problems and notes a file may cost
// ---------------------------------------------------------------------------

describe('tableToLessons: a message quotes a value in at most 40 characters', () => {
  const cut = `”${'x'.repeat(40)}…”`;

  it.each([
    ['Dag', 'Dagen'],
    ['Start', 'Starttiden'],
    ['Slut', 'Sluttiden'],
    ['Längd', 'Längden'],
    ['Från', 'Datumet'],
    ['Till', 'Datumet'],
    ['Veckomönster', 'Veckomönstret'],
  ])('%s', (column, what) => {
    const [problem] = problemsOf({ [column]: 'x'.repeat(32_767) });
    expect(problem!.message.startsWith(`${what} ${cut} `)).toBe(true);
    expect(problem!.message.length).toBeLessThan(200);
  });

  it('puts the value on one line, redacted of nothing it may keep, and shows a short one whole', () => {
    expect(problemsOf({ Dag: 'tre\nrader\t och   blanka' })[0]!.message).toMatch(/^Dagen ”tre rader och blanka” går inte/);
    expect(problemsOf({ Dag: 'x'.repeat(40) })[0]!.message).toMatch(/^Dagen ”x{40}” går inte/);
    expect(problemsOf({ Dag: 'x'.repeat(41) })[0]!.message).toMatch(/^Dagen ”x{40}…” går inte/);
  });
});

describe('tableToLessons: a file of bad rows costs 500 problems and one line', () => {
  it('keeps the first 500, counts the rest in one closing line, and still returns the lessons it could read', () => {
    const parsed = tableToLessons(table(...Array.from({ length: 700 }, () => row({ Dag: 'x' })), row()));
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.problems).toHaveLength(MAX_PROBLEMS + 1);
    expect(parsed.problems[0]).toMatchObject({ ref: 'rad 2', code: 'TABLE_BAD_DAY' });
    expect(parsed.problems[MAX_PROBLEMS - 1]).toMatchObject({ ref: `rad ${MAX_PROBLEMS + 1}`, code: 'TABLE_BAD_DAY' });
    expect(parsed.problems[MAX_PROBLEMS]).toEqual({ ref: '', code: 'TABLE_TOO_MANY_PROBLEMS', message: 'Ytterligare 200 problem visas inte.' });
  });

  it('counts problems, not rows: a row with five problems is five of the 500', () => {
    const five = row({ Dag: 'x', Start: 'x', Slut: 'x', Från: 'x', Veckomönster: 'x' });
    const parsed = tableToLessons(table(...Array.from({ length: 150 }, () => five)));
    expect(parsed.problems).toHaveLength(MAX_PROBLEMS + 1);
    expect(parsed.problems.at(-1)!.message).toBe('Ytterligare 250 problem visas inte.');
  });

  it('counts the unreadable rows with a personnummer in the same 500', () => {
    const parsed = tableToLessons(table(...Array.from({ length: 501 }, () => row({ Block: '19800101-1234' }))));
    expect(parsed.problems).toHaveLength(MAX_PROBLEMS + 1);
    expect(parsed.problems.at(-1)!.message).toBe('Ytterligare 1 problem visas inte.');
    expect(JSON.stringify(parsed)).not.toMatch(NUMBER_DIGITS);
  });

  it('says nothing more when there are exactly 500', () => {
    const parsed = tableToLessons(table(...Array.from({ length: MAX_PROBLEMS }, () => row({ Dag: 'x' }))));
    expect(parsed.problems).toHaveLength(MAX_PROBLEMS);
    expect(parsed.problems.some((problem) => problem.code === 'TABLE_TOO_MANY_PROBLEMS')).toBe(false);
  });

  it('is the same for a CSV file of cells of 32 767 characters, which are all in the file and not shared (about 20 MB here)', () => {
    const long = 'x'.repeat(32_767);
    const bad = row({ Dag: long, Från: long, Till: long, Veckomönster: long });
    const parsed = parseCsv(writeCsv(table(...Array.from({ length: 150 }, () => bad))));
    const started = Date.now();
    const result = tableToLessons(parsed.rows, parsed.rowNumbers);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.problems).toHaveLength(MAX_PROBLEMS + 1);
    expect(JSON.stringify(result).length).toBeLessThan(200_000);
  });

  it('is the same for an Excel file in which 5 000 cells are one shared string, and asks about it once', () => {
    const long = 'x'.repeat(32_767);
    const spy = jest.spyOn(fileSafety, 'hasPersonalNumber');
    try {
      const rows = table(...Array.from({ length: 5000 }, () => row({ Dag: long, Från: long, Till: long, Veckomönster: long, Block: long })));
      const started = Date.now();
      const result = tableToLessons(rows);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result.problems).toHaveLength(MAX_PROBLEMS + 1);
      expect(JSON.stringify(result).length).toBeLessThan(200_000);
      expect(spy.mock.calls.filter(([text]) => (text ?? '').length > 1000)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('reads 5 000 lessons that share a long block name, asking about it once', () => {
    const long = 'x'.repeat(32_767);
    const spy = jest.spyOn(fileSafety, 'hasPersonalNumber');
    try {
      const parsed = tableToLessons(table(...Array.from({ length: 5000 }, () => row({ Block: long }))));
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons).toHaveLength(5000);
      expect(spy.mock.calls.filter(([text]) => (text ?? '').length > 1000)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('tableToLessons: a note is one per distinct thing, and short', () => {
  const required = ['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut'];
  const lesson = ['7A', 'Ma', 'Mån', '08:10', '09:10'];
  const wide = (extra: string[]): string[][] => [[...required, ...extra], [...lesson, ...extra.map(() => 'x')]];

  it('names ten unrecognised headers and counts the rest, however wide the header row', () => {
    const parsed = tableToLessons(wide(Array.from({ length: 1000 }, (_v, i) => `Kol ${i}`)));
    expect(parsed.notes).toEqual([
      'Kolumnerna Kol 0, Kol 1, Kol 2, Kol 3, Kol 4, Kol 5, Kol 6, Kol 7, Kol 8, Kol 9 och 990 till lästes inte: Rastra känner inte igen rubrikerna.',
    ]);
  });

  it('names ten repeated headers, in the order they come, and counts the rest', () => {
    const again = tableToLessons(wide(Array.from({ length: 13 }, (_v, i) => (i % 2 === 0 ? 'Dag' : 'Start'))));
    expect(again.notes).toEqual([
      'Kolumnerna Dag, Start, Dag, Start, Dag, Start, Dag, Start, Dag, Start och 3 till finns flera gånger; den första av varje används.',
    ]);
  });

  it('cuts a header that is very long, on one line', () => {
    const parsed = tableToLessons(wide(['Anteckning\nom\tsalen'.padEnd(5000, 'y')]));
    expect(parsed.notes).toEqual([`Kolumnen Anteckning om salen${'y'.repeat(21)}… lästes inte: Rastra känner inte igen rubriken.`]);
  });

  it('says once for a personnummer header that is repeated, and names ten of many different ones', () => {
    const same = tableToLessons(wide(['Personnummer', 'Personnummer', 'PERSONNUMMER']));
    expect(same.notes).toEqual([
      'Kolumnen Personnummer lästes inte: Rastra tar inte emot personnummer.',
      'Kolumnen PERSONNUMMER lästes inte: Rastra tar inte emot personnummer.',
    ]);
    const many = tableToLessons(wide(Array.from({ length: 25 }, (_v, i) => `Personnummer ${i}`)));
    expect(many.notes).toHaveLength(11);
    expect(many.notes[0]).toBe('Kolumnen Personnummer 0 lästes inte: Rastra tar inte emot personnummer.');
    expect(many.notes[9]).toBe('Kolumnen Personnummer 9 lästes inte: Rastra tar inte emot personnummer.');
    expect(many.notes[10]).toBe('15 kolumner till vars rubrik säger personnummer lästes inte: Rastra tar inte emot personnummer.');
  });
});

// ---------------------------------------------------------------------------
// One row at a time
// ---------------------------------------------------------------------------

describe('tableToLessons: a row', () => {
  it('trims every cell and collapses nothing else', () => {
    const lesson = readOne({ 'Klass/grupp': '  7A  ', Ämne: ' Idrott   och hälsa ', Sal: ' A  101 ', Block: '  Språkval ' });
    expect([lesson.group, lesson.subject, lesson.room, lesson.block]).toEqual(['7A', 'Idrott   och hälsa', 'A  101', 'Språkval']);
  });

  it('skips a row of empty cells without a word, and reports a row that is missing values, naming the columns', () => {
    const parsed = tableToLessons(table(row(), LESSON_TABLE_HEADER.map(() => ''), LESSON_TABLE_HEADER.map(() => '  '), row({ Ämne: '', Start: '' }), row({ 'Klass/grupp': '' })));
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.problems).toEqual([
      { ref: 'rad 5', code: 'TABLE_MISSING_VALUE', message: 'Värde saknas i kolumnerna Ämne och Start.' },
      { ref: 'rad 6', code: 'TABLE_MISSING_VALUE', message: 'Värde saknas i kolumnen Klass/grupp.' },
    ]);
  });

  it('reports every problem of a row, so that a file is fixed in one pass, and skips the lesson', () => {
    const problems = problemsOf({ Dag: 'Mo', Start: '25:00', Slut: 'slut', Från: '17/8/2026', Veckomönster: 'C', Medlärare: 'BLU' });
    expect(problems.map((p) => p.code)).toEqual(['TABLE_BAD_DAY', 'TABLE_BAD_TIME', 'TABLE_BAD_TIME', 'TABLE_BAD_DATE', 'TABLE_BAD_WEEKS', 'TABLE_CO_WITHOUT_LEAD']);
    for (const problem of problems) expect(problem.ref).toBe('rad 2');
  });

  describe('the day', () => {
    const names: [number, string[]][] = [
      [1, ['1', 'Mån', 'Måndag', 'Mon', 'Monday', 'mån', 'MÅNDAG', 'man', 'Mån.', 'MONDAY']],
      [2, ['2', 'Tis', 'Tisdag', 'Tue', 'Tues', 'Tuesday']],
      [3, ['3', 'Ons', 'Onsdag', 'Wed', 'Wednesday']],
      [4, ['4', 'Tor', 'Tors', 'Torsdag', 'Thu', 'Thur', 'Thurs', 'Thursday']],
      [5, ['5', 'Fre', 'Fredag', 'Fri', 'Friday']],
      [6, ['6', 'Lör', 'Lördag', 'Sat', 'Saturday']],
      [7, ['7', 'Sön', 'Söndag', 'Sun', 'Sunday']],
    ];
    it.each(names)('reads day %i from every spelling', (day, spellings) => {
      for (const spelling of spellings) expect(readOne({ Dag: spelling }).day).toBe(day);
    });

    it.each(['0', '8', '10', 'Måndagen', 'Mo', 'x'])('refuses %j and says what is allowed', (text) => {
      const [problem] = problemsOf({ Dag: text });
      expect(problem).toMatchObject({ code: 'TABLE_BAD_DAY', ref: 'rad 2' });
      expect(problem!.message).toBe(`Dagen ”${text}” går inte att läsa. Skriv Mån, Tis, Ons, Tors, Fre, Lör, Sön eller 1–7.`);
    });
  });

  describe('times', () => {
    it.each([
      ['8:10', '08:10'],
      ['08:10', '08:10'],
      ['08.10', '08:10'],
      ['8.10', '08:10'],
      ['0810', '08:10'],
      ['810', '08:10'],
      ['08:10:00', '08:10'],
      ['8.10.00', '08:10'],
      ['23:59', '23:59'],
      ['00:00', '00:00'],
    ])('reads %s as %s', (text, expected) => {
      if (expected !== '23:59') expect(readOne({ Start: text, Slut: '23:59' }).start).toBe(expected);
      if (expected !== '00:00') expect(readOne({ Start: '00:00', Slut: text }).end).toBe(expected);
    });

    it('turns the end into HH:MM too, so Excel fractions already converted by readXlsx pass straight through', () => {
      const lesson = readOne({ Start: '8:10', Slut: '9.10' });
      expect([lesson.start, lesson.end]).toEqual(['08:10', '09:10']);
    });

    it.each(['24:00', '25:00', '8:7', '08:60', '08:10:30', '8', '08:10 AM', 'åtta', '08-10', '12345'])('refuses the start %j', (text) => {
      const problems = problemsOf({ Start: text });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ code: 'TABLE_BAD_TIME' });
      expect(problems[0]!.message).toBe(`Starttiden ”${text}” går inte att läsa som klockslag (HH:MM).`);
    });

    it('refuses an unreadable end, and an end that is not after the start, naming both', () => {
      expect(problemsOf({ Slut: 'kvart över' })[0]!.message).toBe('Sluttiden ”kvart över” går inte att läsa som klockslag (HH:MM).');
      expect(problemsOf({ Start: '09:00', Slut: '08:00' })).toEqual([
        { ref: 'rad 2', code: 'TABLE_BAD_TIME', message: 'Sluttiden 08:00 är inte efter starttiden 09:00.' },
      ]);
      expect(problemsOf({ Start: '09:00', Slut: '9.00' })[0]!.code).toBe('TABLE_BAD_TIME');
    });
  });

  describe('the length is a check, never a source', () => {
    it('accepts an absent, empty or matching length, in the spellings Excel gives', () => {
      for (const length of ['', '60', '60,0', '60.0', ' 60 ']) expect(readOne({ Längd: length }).end).toBe('09:10');
    });

    it('refuses a length that disagrees with start and end, naming both numbers, and skips the lesson', () => {
      expect(problemsOf({ Längd: '45' })).toEqual([
        { ref: 'rad 2', code: 'TABLE_LENGTH_MISMATCH', message: 'Längden ”45” stämmer inte med start 08:10 och slut 09:10, som är 60 minuter. Rätta längden eller tiderna.' },
      ]);
      expect(problemsOf({ Längd: '60,5' })[0]!.code).toBe('TABLE_LENGTH_MISMATCH');
      expect(problemsOf({ Längd: 'en timme' })[0]!.code).toBe('TABLE_LENGTH_MISMATCH');
    });

    it('does not read the length when there are no usable times, and does not add to a time problem', () => {
      expect(problemsOf({ Start: 'x', Längd: '45' }).map((p) => p.code)).toEqual(['TABLE_BAD_TIME']);
      expect(problemsOf({ Start: '09:00', Slut: '08:00', Längd: '45' }).map((p) => p.code)).toEqual(['TABLE_BAD_TIME']);
    });

    it('is the only column checked: Period and Låst may say anything', () => {
      const lesson = readOne({ Period: 'Vårterminen 1990', Låst: 'Nej', Från: '2026-08-17', Till: '2026-12-18' });
      expect([lesson.from, lesson.to]).toEqual(['2026-08-17', '2026-12-18']);
    });
  });

  describe('dates', () => {
    it.each([
      ['2026-08-17', '2026-08-17'],
      ['2026-8-17', '2026-08-17'],
      ['2026-8-7', '2026-08-07'],
      ['20260817', '2026-08-17'],
      ['2028-02-29', '2028-02-29'],
      ['2000-02-29', '2000-02-29'],
      ['2026-04-30', '2026-04-30'],
      ['2026-12-31', '2026-12-31'],
    ])('reads %s as %s', (text, expected) => {
      expect(readOne({ Från: text }).from).toBe(expected);
      expect(readOne({ Till: text }).to).toBe(expected);
    });

    it('leaves an empty date null: the lesson runs from the start of the year, to its end', () => {
      expect(readOne({})).toMatchObject({ from: null, to: null });
    });

    it.each(['17/8/2026', '8/17/2026', '17.8.2026', '2026-13-01', '2026-00-10', '2026-02-29', '2100-02-29', '2026-04-31', '2026-08-32', '2026-08-00', '0999-01-01', '20261301', '2026-8', 'imorgon'])(
      'refuses %s in either column, naming the column',
      (text) => {
        const from = problemsOf({ Från: text });
        expect(from).toEqual([{ ref: 'rad 2', code: 'TABLE_BAD_DATE', message: `Datumet ”${text}” i kolumnen Från går inte att läsa. Skriv ÅÅÅÅ-MM-DD.` }]);
        expect(problemsOf({ Till: text })[0]!.message).toContain('i kolumnen Till');
      },
    );

    it('refuses a period that ends before it begins', () => {
      expect(problemsOf({ Från: '2026-12-18', Till: '2026-08-17' })).toEqual([
        { ref: 'rad 2', code: 'TABLE_BAD_DATE', message: 'Perioden börjar 2026-12-18, efter att den slutar 2026-08-17.' },
      ]);
      expect(readOne({ Från: '2026-08-17', Till: '2026-08-17' }).to).toBe('2026-08-17');
    });
  });

  describe('week patterns', () => {
    it.each([
      ['', 'ALL'], ['alla', 'ALL'], ['Varje vecka', 'ALL'],
      ['A', 'ODD'], ['a', 'ODD'], ['udda', 'ODD'], ['Odd', 'ODD'],
      ['B', 'EVEN'], ['jämn', 'EVEN'], ['Even', 'EVEN'],
    ])('reads %j as %s', (text, expected) => {
      expect(readOne({ Veckomönster: text }).weeks).toBe(expected);
    });

    it.each(['C', 'A+B', 'vecka 3', '1'])('refuses %j', (text) => {
      const [problem] = problemsOf({ Veckomönster: text });
      expect(problem).toMatchObject({ code: 'TABLE_BAD_WEEKS', ref: 'rad 2' });
      expect(problem!.message).toBe(`Veckomönstret ”${text}” går inte att läsa. Skriv A (udda veckor), B (jämna veckor) eller lämna tomt.`);
    });
  });

  describe('teachers', () => {
    it('takes a teacher with only a name, only an e-mail, or only a signature, and leaves the rest null', () => {
      expect(readOne({ Lärarnamn: 'Anna Berg' }).teachers).toEqual([{ short: null, name: 'Anna Berg', email: null, id: null }]);
      expect(readOne({ 'Lärare e-post': 'a@skolan.se' }).teachers).toEqual([{ short: null, name: null, email: 'a@skolan.se', id: null }]);
      expect(readOne({ Lärare: 'ABE' }).teachers).toEqual([{ short: 'ABE', name: null, email: null, id: null }]);
      expect(readOne({ 'Lärar-id': 'u1' }).teachers).toEqual([{ short: null, name: null, email: null, id: 'u1' }]);
      expect(readOne({}).teachers).toEqual([]);
    });

    it('takes a lead and a co-teacher, in that order', () => {
      expect(readOne({ Lärare: 'ABE', Medlärare: 'BLU', 'Medlärar-id': 'u2', 'Medlärare e-post': 'b@x.se', Medlärarnamn: 'Bo' }).teachers).toEqual([
        { short: 'ABE', name: null, email: null, id: null },
        { short: 'BLU', name: 'Bo', email: 'b@x.se', id: 'u2' },
      ]);
    });

    it('refuses a co-teacher without a lead, and skips the lesson: nothing is promoted by guess', () => {
      const cases: Record<string, string>[] = [{ Medlärare: 'BLU' }, { Medlärarnamn: 'Bo' }, { 'Medlärare e-post': 'b@x.se' }, { 'Medlärar-id': 'u2' }];
      for (const co of cases) {
        expect(problemsOf(co)).toEqual([
          { ref: 'rad 2', code: 'TABLE_CO_WITHOUT_LEAD', message: 'Det finns en medlärare men ingen lärare. Flytta medläraren till kolumnen Lärare.' },
        ]);
      }
    });
  });

  describe('ids and the extra classes', () => {
    it('reads the ids that are there and leaves the others absent, so a table without ids reads as lessons without ids', () => {
      expect(readOne({}).ids).toEqual({});
      expect(readOne({ 'Lektions-id': 'l1', 'Grupp-id': 'g1', 'Ämnes-id': 's1', 'Sal-id': 'r1' }).ids).toEqual({ lesson: 'l1', group: 'g1', subject: 's1', room: 'r1' });
    });

    it('splits the extra classes on the bar, trims, and drops empties, duplicates and the lesson\'s own group', () => {
      expect(readOne({ 'Ytterligare klasser': ' 8B |7C||  8B | 7A | 7C ' }).extraGroups).toEqual(['8B', '7C']);
      expect(readOne({ 'Ytterligare klasser': '8B' }).extraGroups).toEqual(['8B']);
      expect(readOne({ 'Ytterligare klasser': '|' }).extraGroups).toEqual([]);
      // Case is not folded: "8b" is not "8B".
      expect(readOne({ 'Ytterligare klasser': '8B | 8b' }).extraGroups).toEqual(['8B', '8b']);
    });

    it('keeps each id with its class, whatever is dropped, and gives no id list when none has an id', () => {
      expect(readOne({ 'Ytterligare klasser': '8B | 7C | 7A', 'Ytterligare klass-id': 'g8B |  | gA' }).ids.extraGroups).toEqual(['g8B', null]);
      expect(readOne({ 'Ytterligare klasser': '8B |  | 8B | 7C', 'Ytterligare klass-id': 'x | y | z | w' }).ids.extraGroups).toEqual(['x', 'w']);
      expect(readOne({ 'Ytterligare klasser': '8B | 7C', 'Ytterligare klass-id': 'g8B' }).ids.extraGroups).toEqual(['g8B', null]);
      expect(readOne({ 'Ytterligare klasser': '8B | 7C' }).ids).toEqual({});
      expect(readOne({ 'Ytterligare klass-id': 'g1 | g2' }).ids).toEqual({});
    });
  });

  it('keeps lessons that differ only in letter case apart, and does not look at any other row to decide', () => {
    const parsed = tableToLessons(table(row({ 'Klass/grupp': '7a', Sal: 'a101' }), row({ 'Klass/grupp': '7A', Sal: 'A101' })));
    expect(parsed.lessons.map((l) => [l.group, l.room])).toEqual([['7a', 'a101'], ['7A', 'A101']]);
  });

  it('reads the subject code, the block and the room as null when empty', () => {
    expect(readOne({})).toMatchObject({ subjectCode: null, room: null, block: null });
    expect(readOne({ Ämneskod: 'MA', Sal: 'A101', Block: 'Språkval' })).toMatchObject({ subjectCode: 'MA', room: 'A101', block: 'Språkval' });
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('tableToLessons: the size limit', () => {
  const many = (n: number): string[][] => table(...Array.from({ length: n }, () => row()));

  it('takes MAX_EXCHANGE_LESSONS rows, not counting empty ones', () => {
    const rows = many(MAX_EXCHANGE_LESSONS);
    rows.splice(10, 0, LESSON_TABLE_HEADER.map(() => ''), []);
    const parsed = tableToLessons(rows);
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons).toHaveLength(MAX_EXCHANGE_LESSONS);
  });

  it('refuses one row more with one problem, naming the first row over the limit, and reads nothing', () => {
    const parsed = tableToLessons(many(MAX_EXCHANGE_LESSONS + 1));
    expect(parsed.lessons).toEqual([]);
    expect(parsed.problems).toEqual([
      {
        ref: `rad ${MAX_EXCHANGE_LESSONS + 2}`,
        code: 'TABLE_TOO_MANY_ROWS',
        message: `Tabellen har ${MAX_EXCHANGE_LESSONS + 1} rader med innehåll; högst ${MAX_EXCHANGE_LESSONS} lektioner tas emot åt gången. Dela tabellen i flera filer.`,
      },
    ]);
  });
});
