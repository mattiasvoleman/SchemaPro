import { BadRequestException } from '@nestjs/common';
import { smallSchoolDocument, highSchoolDocument } from './__fixtures__/documents';
import { MAX_EXCHANGE_BYTES } from './exchange-model';
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
    expect(decodeText(Buffer.from('åäö', 'utf8'))).toEqual({ text: 'åäö', legacyEncoding: false });
    expect(decodeText(Buffer.from('åäö', 'latin1'))).toEqual({ text: 'åäö', legacyEncoding: true });
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
