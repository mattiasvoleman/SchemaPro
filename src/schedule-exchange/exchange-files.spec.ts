import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { smallSchoolDocument, highSchoolDocument } from './__fixtures__/documents';
import { MAX_EXCHANGE_BYTES } from './exchange-model';
import { MAX_UPLOAD_BYTES } from './exchange-model';
import { decodeText, fileStem, parsePeriods, readUpload, renderExport, EXCHANGE_FORMATS, type ExchangeFormat } from './exchange-files';
import { readZip } from './zip';

const lessonKey = (l: { group: string; subject: string; day: number; start: string; end: string; weeks: string }) =>
  [l.group, l.subject, l.day, l.start, l.end, l.weeks].join('|');

describe('renderExport and readUpload', () => {
  it.each(EXCHANGE_FORMATS)('%s: what the page downloads is what the import reads back', (format: ExchangeFormat) => {
    for (const doc of [smallSchoolDocument(), highSchoolDocument()]) {
      const file = renderExport(format, doc);
      expect(file.filename).toMatch(/^rastra-schema-2026-2027/);
      const parsed = readUpload(format, [{ name: file.filename, bytes: file.body }]);
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons.map(lessonKey).sort()).toEqual(doc.lessons.map(lessonKey).sort());
    }
  });

  it('answers an xlsx export too large for the reader to take back with a 400 that says so, not a 500', () => {
    const doc = smallSchoolDocument();
    doc.lessons = Array.from({ length: 400 }, (_v, i) => ({ ...doc.lessons[0]!, group: `${i}-${randomBytes(15_000).toString('hex')}` }));
    expect(() => renderExport('TABLE_XLSX', doc)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'EXPORT_XLSX_TOO_LARGE' }) }));
    // The same table is fine as a CSV.
    expect(renderExport('TABLE_CSV', doc).body.length).toBeGreaterThan(0);
  });

  it('says in a note when a file is too large to be read back here, and what to do', () => {
    const doc = smallSchoolDocument();
    // 5 000 lessons of a school with 30 classes, 8 subjects, 10 rooms and 40 teachers: only the lesson's own id is its own.
    const pick = (ids: string[], i: number) => ids[i % ids.length]!;
    const groups = Array.from({ length: 30 }, () => randomUUID());
    const subjects = Array.from({ length: 8 }, () => randomUUID());
    const rooms = Array.from({ length: 10 }, () => randomUUID());
    const teachers = Array.from({ length: 40 }, () => randomUUID());
    doc.lessons = Array.from({ length: 5000 }, (_v, i) => ({
      ...doc.lessons[0]!,
      day: (i % 5) + 1,
      start: `${String(8 + (i % 8)).padStart(2, '0')}:00`,
      end: `${String(9 + (i % 8)).padStart(2, '0')}:00`,
      ids: { lesson: randomUUID(), group: pick(groups, i), subject: pick(subjects, i), room: pick(rooms, i), extraGroups: [] },
      teachers: [{ short: `T${i % 40}`, name: `Lärare ${i % 40}`, email: `l${i % 40}@skolan.example`, id: pick(teachers, i) }],
    }));
    const csv = renderExport('TABLE_CSV', doc);
    expect(csv.body.length).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(csv.notes).toHaveLength(1);
    expect(csv.notes[0]).toMatch(/^Filen är \d+ kB\. Rastra tar emot högst 700 kB vid inläsning/);
    expect(csv.notes[0]).toContain('Excel');
    // The Excel file is a fraction of it, fits, and comes back.
    const xlsx = renderExport('TABLE_XLSX', doc);
    expect(xlsx.body.length).toBeLessThan(MAX_UPLOAD_BYTES);
    expect(xlsx.notes).toEqual([]);
    expect(readUpload('TABLE_XLSX', [{ name: 'a.xlsx', bytes: xlsx.body }]).lessons).toHaveLength(5000);
  });

  it('points a format with no Excel twin at the general remedy', () => {
    const doc = smallSchoolDocument();
    doc.lessons = Array.from({ length: 3000 }, (_v, i) => ({ ...doc.lessons[0]!, ids: { lesson: randomUUID() }, day: (i % 5) + 1, start: `${String(8 + (i % 8)).padStart(2, '0')}:00`, end: `${String(9 + (i % 8)).padStart(2, '0')}:00`, room: `Sal ${randomBytes(100).toString('hex')}` }));
    const asc = renderExport('ASC_XML', doc);
    expect(asc.body.length).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(asc.notes.at(-1)).toContain('Ett annat format');
  });

  it('says nothing about size for a file that fits', () => {
    for (const format of EXCHANGE_FORMATS) expect(renderExport(format, smallSchoolDocument()).notes.filter((n) => n.startsWith('Filen är'))).toEqual([]);
  });

  it('carries the Untis writer’s notes out with the file, and none for the other formats', () => {
    const doc = smallSchoolDocument();
    doc.teachers = [{ short: 'A,B', name: 'Anna Berg', email: null, id: null }, ...doc.teachers];
    doc.lessons = [{ ...doc.lessons[0]!, teachers: [doc.teachers[0]!] }, ...doc.lessons.slice(1)];
    expect(renderExport('UNTIS_GPU', doc).notes.join(' ')).toContain('A,B');
    for (const format of ['TABLE_CSV', 'TABLE_XLSX', 'ASC_XML'] as const) expect(renderExport(format, doc).notes).toEqual([]);
  });

  it('puts the Untis files in one zip, with no GPU011 (Untis writes no time grid)', () => {
    const file = renderExport('UNTIS_GPU', smallSchoolDocument());
    expect(file.contentType).toBe('application/zip');
    expect([...readZip(file.body).keys()]).toEqual(['GPU001.TXT', 'GPU002.TXT']);
  });

  it('reads Untis files uploaded loose, in any case and with a path, or in a zip', () => {
    const zip = renderExport('UNTIS_GPU', smallSchoolDocument());
    const files = [...readZip(zip.body)].map(([name, bytes]) => ({ name: `Untis/${name.toLowerCase()}`, bytes }));
    expect(readUpload('UNTIS_GPU', files).lessons).toHaveLength(smallSchoolDocument().lessons.length);
    expect(readUpload('UNTIS_GPU', [{ name: 'ut.zip', bytes: zip.body }]).lessons).toHaveLength(smallSchoolDocument().lessons.length);
  });

  it('says what is missing or doubled among the Untis files', () => {
    const zip = renderExport('UNTIS_GPU', smallSchoolDocument());
    const parts = [...readZip(zip.body)].map(([name, bytes]) => ({ name, bytes }));
    expect(() => readUpload('UNTIS_GPU', [parts[1]!])).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'IMPORT_UNTIS_NO_GPU001' }) }));
    expect(() => readUpload('UNTIS_GPU', [parts[0]!, parts[0]!])).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'IMPORT_FILE_COUNT' }) }));
  });

  it('turns a period-numbered Untis file into times only through the school’s own grid', () => {
    const gpu001 = '1,"7A","ABE","MA","A101",1,1\r\n';
    const bytes = Buffer.from(gpu001, 'utf8');
    const without = readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes }]);
    expect(without.lessons).toHaveLength(0);
    expect(without.problems.map((p) => p.code)).toEqual(['GPU_UNKNOWN_PERIOD']);
    const withGrid = readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes }], { periods: '1 08:10-09:10\n2 09:20-10:20' });
    expect(withGrid.lessons.map((l) => [l.group, l.start, l.end])).toEqual([['7A', '08:10', '09:10']]);
  });

  it('refuses a file of the wrong shape with a 400 that says which', () => {
    expect(() => readUpload('TABLE_CSV', [])).toThrow(BadRequestException);
    expect(() => readUpload('TABLE_CSV', [{ name: 'a.csv', bytes: Buffer.alloc(MAX_EXCHANGE_BYTES + 1) }])).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'IMPORT_FILE_TOO_LARGE' }) }));
    expect(() => readUpload('TABLE_XLSX', [{ name: 'a.xlsx', bytes: Buffer.from('nope') }])).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'IMPORT_XLSX_UNREADABLE' }) }));
  });

  it('says in the notes when a CSV was windows-1252, or had a quote that never closed', () => {
    const latin = readUpload('TABLE_CSV', [{ name: 'a.csv', bytes: Buffer.from('Klass/grupp;Ämne;Dag;Start;Slut\r\n7A;Matematik;Mån;08:10;09:10\r\n', 'latin1') }]);
    expect(latin.lessons).toHaveLength(1);
    expect(latin.notes.some((n) => n.includes('windows-1252'))).toBe(true);
    const open = readUpload('TABLE_CSV', [{ name: 'a.csv', bytes: Buffer.from('Klass/grupp;Ämne;Dag;Start;Slut\r\n7A;"Matematik;Mån;08:10;09:10\r\n', 'utf8') }]);
    expect(open.notes.some((n) => n.includes('citattecken'))).toBe(true);
  });

  it('notes a legacy encoding in an Untis file', () => {
    const bytes = Buffer.from('1,"7A","ABE","Matematik","A101",1,510,"01:00"\r\n"ÅÄÖ"\r\n', 'latin1');
    const parsed = readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes }]);
    expect(parsed.notes.some((n) => n.includes('windows-1252'))).toBe(true);
  });
});

describe('decodeText, fileStem and parsePeriods', () => {
  it('reads UTF-8 with or without a mark, else windows-1252', () => {
    expect(decodeText(Buffer.from('åäö', 'utf8'))).toEqual({ text: 'åäö', legacyEncoding: false, encoding: 'utf-8' });
    expect(decodeText(Buffer.from('åäö', 'latin1'))).toEqual({ text: 'åäö', legacyEncoding: true, encoding: 'windows-1252' });
  });

  describe('a file that is not UTF-8 (M3 of the review)', () => {
    /** Mac Roman and windows-1252 bytes of the few characters a Swedish timetable has. */
    const MAC: Record<string, number> = { å: 0x8c, ä: 0x8a, ö: 0x9a, Å: 0x81, Ä: 0x80, Ö: 0x85, é: 0x8e, ü: 0x9f, '–': 0xd0, '“': 0xd2, '”': 0xd3 };
    const WIN: Record<string, number> = { å: 0xe5, ä: 0xe4, ö: 0xf6, Å: 0xc5, Ä: 0xc4, Ö: 0xd6, é: 0xe9, ü: 0xfc, '–': 0x96, '“': 0x93, '”': 0x94 };
    const encode = (text: string, table: Record<string, number>) => Buffer.from([...text].map((c) => table[c] ?? c.charCodeAt(0)));

    it('reads Mac Roman, which Excel for Mac writes, by the Swedish letters in it', () => {
      const text = 'Klass/grupp;Ämne;Lärare\r\n7Å;Matematik;Östen\r\n';
      expect(decodeText(encode(text, MAC))).toEqual({ text, legacyEncoding: true, encoding: 'macintosh' });
    });

    it('reads windows-1252 as ever, also when the file is written with a Mac’s kind of dash and quotes', () => {
      const text = 'Klass/grupp;Ämne\r\n7Å;Matematik – “Östen”\r\n';
      expect(decodeText(encode(text, WIN))).toEqual({ text, legacyEncoding: true, encoding: 'windows-1252' });
    });

    it('is not decided by typographic signs: a dash and quotation marks alone vote for neither', () => {
      // 96 is a dash in windows-1252 and 'û' in Mac Roman; D0 an 'Ð' there and a dash here. Without a Swedish letter the guess is Excel for Windows.
      expect(decodeText(encode('– “x”', MAC)).encoding).toBe('windows-1252');
      // One Swedish letter outvotes any number of signs.
      expect(decodeText(encode('“a” “b” “c” – – – ö', MAC)).encoding).toBe('macintosh');
      expect(decodeText(encode('“a” “b” “c” – – – ö', WIN)).encoding).toBe('windows-1252');
    });

    it('reads the same file the same whether the page’s CSV reader or this one sees it', () => {
      const text = 'Klass/grupp;Ämne;Dag;Start;Slut\r\n7A;Matematik;Mån;08:10;09:10\r\n7B;Slöjd;Tis;08:10;09:10\r\n';
      for (const [table, name] of [[MAC, 'Mac Roman'], [WIN, 'windows-1252']] as const) {
        const parsed = readUpload('TABLE_CSV', [{ name: 'a.csv', bytes: encode(text, table) }]);
        expect(parsed.lessons.map((l) => [l.group, l.subject, l.day])).toEqual([['7A', 'Matematik', 1], ['7B', 'Slöjd', 2]]);
        expect(parsed.notes.some((n) => n.includes(name))).toBe(true);
      }
    });

    it('says which one it read, in the Untis file’s note too', () => {
      const bytes = encode('1,"7A","ABE","Matematik","A101",1,510,"01:00"\r\n"ÅÄÖ"\r\n', MAC);
      const parsed = readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes }]);
      expect(parsed.notes.some((n) => n.includes('Mac Roman'))).toBe(true);
    });
  });

  it('makes a file name of a year name', () => {
    expect(fileStem('2026/2027')).toBe('rastra-schema-2026-2027');
    expect(fileStem('Läsår!')).toBe('rastra-schema-Lasar');
    expect(fileStem('///')).toBe('rastra-schema-lasar');
  });

  it('reads the grid the school types, in the shapes people type it', () => {
    expect(parsePeriods(undefined)).toEqual([]);
    expect(parsePeriods('1 08:10-09:10\r\n\r\n2: 9.20 – 10.20\n3;10:30;11:30\n4 12:30 13:30')).toEqual([
      { number: 1, start: '08:10', end: '09:10' },
      { number: 2, start: '09:20', end: '10:20' },
      { number: 3, start: '10:30', end: '11:30' },
      { number: 4, start: '12:30', end: '13:30' },
    ]);
  });

  it('names the line of a grid that is no grid, and never guesses one', () => {
    for (const bad of ['1 08:10', 'första 08:10-09:10', '1 09:10-08:10', '1 08:10-09:10\n1 09:20-10:20', '1 25:00-26:00']) {
      expect(() => parsePeriods(bad)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'IMPORT_PERIODS_UNREADABLE' }) }));
    }
    expect(() => parsePeriods('1 08:10-09:10\nnonsense')).toThrow(/rad 2/);
  });
});
