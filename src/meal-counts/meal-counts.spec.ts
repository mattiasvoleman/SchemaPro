import { encodeWindows1252 } from '../common/windows-1252';
import fixture from './__fixtures__/week.json';
import {
  buildMealView,
  CSV_HEADER,
  MEAL_COUNTS_BAD_ANSWER,
  mealCsv,
  mealCsvName,
  mealCsvRows,
  mealLetter,
  parseMealRows,
  swedishDate,
  type MealClassRow,
  type MealRows,
} from './meal-counts';

const klass = (over: Partial<MealClassRow> & Pick<MealClassRow, 'day' | 'name' | 'start' | 'end'>): MealClassRow => ({
  groupId: `g-${over.name}`,
  pupils: 20,
  absentBefore: 0,
  absentAfter: 0,
  underActivity: false,
  ...over,
});

/** 2027-02-04 is a Thursday. 7A and 7B eat 10:30-11:00, 10A 11:00-11:30; the Friday has 7A alone. */
const rows: MealRows = {
  cutoff: '08:30',
  staffModelled: true,
  classes: [
    klass({ day: '2027-02-04', name: '7B', start: '10:30', end: '11:00', pupils: 25, absentBefore: 2 }),
    klass({ day: '2027-02-04', name: '10A', start: '11:00', end: '11:30', pupils: 30, absentAfter: 3, underActivity: true }),
    klass({ day: '2027-02-04', name: '7A', start: '10:30', end: '11:00', pupils: 24, absentBefore: 1, absentAfter: 1 }),
    klass({ day: '2027-02-05', name: '7A', start: '10:30', end: '11:00', pupils: 24 }),
  ],
  staff: [{ day: '2027-02-04', start: '10:30', end: '11:00', staff: 4 }],
};

describe('buildMealView', () => {
  const view = buildMealView(rows, '2027-02-04', '2027-02-07');

  it('has every day of the period, in order, a day without a sitting with none', () => {
    expect(view.days.map((d) => [d.date, d.weekday, d.sittings.length])).toEqual([
      ['2027-02-04', 4, 2],
      ['2027-02-05', 5, 1],
      ['2027-02-06', 6, 0],
      ['2027-02-07', 7, 0],
    ]);
    expect(view.from).toBe('2027-02-04');
    expect(view.to).toBe('2027-02-07');
  });

  it('makes a sitting of the classes that eat in the same window, earliest first, the classes in natural order', () => {
    const [first, second] = view.days[0]!.sittings;
    expect([first!.start, first!.end, first!.classes.map((c) => c.name)]).toEqual(['10:30', '11:00', ['7A', '7B']]);
    expect([second!.start, second!.end, second!.classes.map((c) => c.name)]).toEqual(['11:00', '11:30', ['10A']]);
    // 10A before 7A in a plain sort, after it in a numeric one.
    expect(buildMealView({ ...rows, classes: [rows.classes[1]!, rows.classes[2]!] }, '2027-02-04', '2027-02-04').days[0]!.sittings.flatMap((s) => s.classes.map((c) => c.name))).toEqual(['7A', '10A']);
  });

  it('counts a sitting as pupils less the absence reported before the cut-off, plus the staff', () => {
    const first = view.days[0]!.sittings[0]!;
    expect(first).toMatchObject({ pupils: 49, absentBefore: 3, staff: 4, portions: 50, absentAfter: 1, underActivity: 0 });
    expect(first.classes.map((c) => [c.name, c.pupils, c.absentBefore, c.portions])).toEqual([
      ['7A', 24, 1, 23],
      ['7B', 25, 2, 23],
    ]);
  });

  it('shows absence reported after the cut-off without taking it off, and counts a class under an activity all the same', () => {
    const second = view.days[0]!.sittings[1]!;
    expect(second).toMatchObject({ pupils: 30, absentBefore: 0, absentAfter: 3, portions: 30, underActivity: 30, staff: 0 });
  });

  it('adds the sittings up to the day and the days stand apart', () => {
    expect(view.days[0]!.totals).toEqual({ pupils: 79, absentBefore: 3, staff: 4, portions: 80, absentAfter: 4, underActivity: 30 });
    expect(view.days[1]!.totals).toEqual({ pupils: 24, absentBefore: 0, staff: 0, portions: 24, absentAfter: 0, underActivity: 0 });
    expect(view.days[2]!.totals).toEqual({ pupils: 0, absentBefore: 0, staff: 0, portions: 0, absentAfter: 0, underActivity: 0 });
  });

  it('carries the cut-off and whether staff are in the model', () => {
    expect([view.cutoff, view.staffModelled]).toEqual(['08:30', true]);
    const none = buildMealView({ cutoff: null, staffModelled: false, classes: [], staff: [] }, '2027-02-04', '2027-02-04');
    expect([none.cutoff, none.staffModelled, none.days[0]!.sittings]).toEqual([null, false, []]);
  });

  it('puts staff only in the sitting whose window they were placed in', () => {
    const moved = buildMealView({ ...rows, staff: [{ day: '2027-02-04', start: '11:00', end: '11:30', staff: 2 }] }, '2027-02-04', '2027-02-04');
    expect(moved.days[0]!.sittings.map((s) => [s.start, s.staff, s.portions])).toEqual([['10:30', 0, 46], ['11:00', 2, 32]]);
  });
});

describe('parseMealRows', () => {
  it('takes the document the database answers, as an object or as text', () => {
    expect(parseMealRows(rows)).toEqual(rows);
    expect(parseMealRows(JSON.stringify(rows))).toEqual(rows);
    expect(parseMealRows({ cutoff: null, staffModelled: false, classes: [], staff: [] }).cutoff).toBeNull();
  });

  it.each([
    ['nothing', null],
    ['not an object', 7],
    ['a cut-off that is not a time', { ...rows, cutoff: '8.30' }],
    ['no staffModelled', { ...rows, staffModelled: undefined }],
    ['classes that are not a list', { ...rows, classes: {} }],
    ['staff that are not a list', { ...rows, staff: null }],
    ['a class with a negative count', { ...rows, classes: [{ ...rows.classes[0]!, pupils: -1 }] }],
    ['a class with a fractional count', { ...rows, classes: [{ ...rows.classes[0]!, absentBefore: 1.5 }] }],
    ['a class with no name', { ...rows, classes: [{ ...rows.classes[0]!, name: '' }] }],
    ['a class with a text where a flag is', { ...rows, classes: [{ ...rows.classes[0]!, underActivity: 'true' }] }],
    ['a staff row with a text count', { ...rows, staff: [{ day: '2027-02-04', start: '10:30', end: '11:00', staff: '4' }] }],
  ])('refuses %s, by name', (_label, doc) => {
    expect(() => parseMealRows(doc)).toThrow(MEAL_COUNTS_BAD_ANSWER);
  });
});

describe('the file', () => {
  const view = buildMealView(rows, '2027-02-04', '2027-02-06');

  it('has one row per day and sitting under the header, a day without a sitting left out', () => {
    expect(mealCsvRows(view)).toEqual([
      [...CSV_HEADER],
      ['2027-02-04', 'torsdag', '10:30', '11:00', '7A 23, 7B 23', '49', '3', '4', '50', '1', '0'],
      ['2027-02-04', 'torsdag', '11:00', '11:30', '10A 30', '30', '0', '0', '30', '3', '30'],
      ['2027-02-05', 'fredag', '10:30', '11:00', '7A 24', '24', '0', '0', '24', '0', '0'],
    ]);
  });

  it('is windows-1252, with ; and CRLF, quoting the cell that has a comma, and no byte-order mark', () => {
    const bytes = mealCsv(view);
    expect(bytes.subarray(0, 3).toString('hex')).not.toBe('efbbbf');
    const text = new TextDecoder('windows-1252').decode(bytes);
    const lines = text.split('\r\n');
    expect(lines.at(-1)).toBe('');
    expect(lines[0]).toBe('Datum;Veckodag;Sittning från;Sittning till;Klasser;Elever;Frånvaro före brytpunkten;Personal;Portioner;Anmäld efter brytpunkten;Elever i klasser med aktivitet');
    expect(lines[1]).toBe('2027-02-04;torsdag;10:30;11:00;"7A 23, 7B 23";49;3;4;50;1;0');
    // The å of "från" is the one byte 0xE5, not UTF-8's two.
    expect(bytes.includes(Buffer.from([0x66, 0x72, 0xe5, 0x6e]))).toBe(true);
    expect(bytes.equals(encodeWindows1252(text))).toBe(true);
  });

  it('writes a header alone for a period with no sitting', () => {
    const empty = buildMealView({ cutoff: null, staffModelled: false, classes: [], staff: [] }, '2027-02-06', '2027-02-07');
    expect(new TextDecoder('windows-1252').decode(mealCsv(empty))).toBe(`${CSV_HEADER.join(';')}\r\n`);
  });

  it('guards a class named like a formula', () => {
    const odd = buildMealView({ ...rows, classes: [klass({ day: '2027-02-04', name: '=A1', start: '10:30', end: '11:00' })], staff: [] }, '2027-02-04', '2027-02-04');
    expect(mealCsvRows(odd)[1]![4]).toBe('=A1 20');
    const text = new TextDecoder('windows-1252').decode(mealCsv(odd));
    expect(text).toContain(";'=A1 20;");
  });

  it('is named for the day, or for the first and the last', () => {
    expect(mealCsvName(buildMealView(rows, '2027-02-04', '2027-02-04'))).toBe('portioner-2027-02-04.csv');
    expect(mealCsvName(view)).toBe('portioner-2027-02-04-2027-02-06.csv');
  });
});

describe('the letter', () => {
  const day = buildMealView(rows, '2027-02-04', '2027-02-04').days[0]!;

  it('names the day in Swedish', () => {
    expect(swedishDate(day)).toBe('torsdag 4 februari 2027');
    expect(swedishDate(buildMealView({ ...rows, classes: [] }, '2027-12-26', '2027-12-26').days[0]!)).toBe('söndag 26 december 2027');
  });

  it('says the portions of each sitting and the total, the classes with theirs, and what is not counted', () => {
    const letter = mealLetter(day, 'Testskolan', '08:30', true);
    expect(letter.subject).toBe('Portioner torsdag 4 februari 2027');
    expect(letter.body).toBe(
      [
        'Portioner torsdag 4 februari 2027 – Testskolan',
        'Läget klockan 08:30.',
        '',
        'Sittning 10:30–11:00: 50 portioner',
        '  elever 49, anmäld frånvaro −3, personal +4',
        '  7A 23, 7B 23',
        '',
        'Sittning 11:00–11:30: 30 portioner',
        '  elever 30, anmäld frånvaro −0, personal +0',
        '  10A 30',
        '  schemabrytande aktivitet över sittningen (räknas med): 10A',
        '',
        'Totalt: 80 portioner.',
        '',
        'Anmäld efter klockan 08:30 och inte avdragen: 4.',
        'Allergier och kostval ingår inte: de lagras inte i Rastra.',
        '',
      ].join('\n'),
    );
  });

  it('says that later absence is not taken off when none has come, and leaves staff out when the model has none', () => {
    const quiet = buildMealView({ ...rows, classes: [rows.classes[3]!].map((c) => ({ ...c, day: '2027-02-04' })), staff: [] }, '2027-02-04', '2027-02-04').days[0]!;
    const letter = mealLetter(quiet, 'Testskolan', '09:00', false);
    expect(letter.body).toContain('Frånvaro som anmäls efter klockan 09:00 är inte avdragen.');
    expect(letter.body).toContain('Personal ingår inte: ingen pedagogisk lunch med fast tid är lagd i Rastra.');
    expect(letter.body).not.toContain('personal +');
    expect(letter.body).toContain('Totalt: 24 portioner.');
  });

  it('carries no pupil, no diet and no address: counts and the names of classes', () => {
    const body = mealLetter(day, 'Testskolan', '08:30', true).body;
    expect(body).not.toMatch(/@|elev [A-ZÅÄÖ]|allergi:|specialkost:/i);
  });
});

/**
 * The view the web page reads, as the gateway builds it. The web's lib/meal-counts.test.ts renders the same
 * file under the page's own types, so a field one side renames is a failure on the other too.
 */
describe('the contract fixture (web/lib/meal-counts.test.ts reads it too)', () => {
  it('is what buildMealView makes of its rows', () => {
    expect(buildMealView(fixture.rows as MealRows, fixture.from, fixture.to)).toEqual(fixture.view);
  });

  it('has a Thursday with two sittings, a Friday with one, a weekend of none and a Monday of one', () => {
    expect(fixture.view.days.map((day) => [day.date, day.weekday, day.sittings.length])).toEqual([
      ['2027-02-04', 4, 2],
      ['2027-02-05', 5, 1],
      ['2027-02-06', 6, 0],
      ['2027-02-07', 7, 0],
      ['2027-02-08', 1, 1],
      ['2027-02-09', 2, 0],
      ['2027-02-10', 3, 0],
    ]);
  });
});
