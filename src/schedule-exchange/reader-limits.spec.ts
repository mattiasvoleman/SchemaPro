/**
 * What a hostile or merely unlucky file may cost (the review of PR #256).
 *
 * Every case here is one the review measured: a small input that held the API
 * process for seconds, or made one answer hundreds of millions of characters.
 * The bounds are generous (an unfixed reader needs 2.5 to 4 seconds, a fixed
 * one a few milliseconds), so a loaded machine does not fail them and a
 * regression does. They are the same inputs at several sizes, so that a
 * rewrite that is only less bad is caught too.
 */
import { writeAscXml, readAscXml } from './asc-xml';
import { parsePeriods, readUpload } from './exchange-files';
import { MAX_PROBLEMS } from './file-safety';
import { highSchoolDocument } from './__fixtures__/documents';
import { readUntisGpu } from './untis-gpu';
import { writeZip } from './zip';

const BOUND_MS = 1500;

/** How long a call takes, whatever it answers: a refusal is an answer. */
function millis<T>(body: () => T): { result: T | undefined; ms: number } {
  const started = process.hrtime.bigint();
  let result: T | undefined;
  try {
    result = body();
  } catch {
    result = undefined;
  }
  return { result, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

describe('reader limits', () => {
  describe('aSc: a period name with a long run of blanks (H2)', () => {
    const xml = writeAscXml(highSchoolDocument());
    const target = [...xml.matchAll(/<termsdef [^>]*name="([^"]*)"/g)].map((m) => m[1]!).find((n) => n.includes('2026-08-17–2026-12-18'))!;

    it.each([0, 8_000, 16_000, 32_000])('a name of a dash, %i blanks and an x is read in no time', (n) => {
      const evil = xml.replace(`name="${target}"`, `name="–${' '.repeat(n)}x"`);
      const { result, ms } = millis(() => readAscXml(evil));
      expect(ms).toBeLessThan(BOUND_MS);
      expect(result!.problems.length).toBeLessThanOrEqual(MAX_PROBLEMS + 1);
    });

    it.each([8_000, 32_000])('a name of date, %i blanks and a dash is read in no time', (n) => {
      const evil = xml.replace(`name="${target}"`, `name="2026-08-17${' '.repeat(n)}–${' '.repeat(n)}x"`);
      expect(millis(() => readAscXml(evil)).ms).toBeLessThan(BOUND_MS);
    });

    it('still reads a term named with its dates', () => {
      const parsed = readAscXml(xml);
      expect(parsed.lessons.some((l) => l.from === '2026-08-17' && l.to === '2026-12-18')).toBe(true);
    });
  });

  describe('xlsx: one shared string used by thousands of cells (H3)', () => {
    const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const b = (s: string) => Buffer.from(s, 'utf8');
    function sharedStringBook(rows: number, long: string): Buffer {
      const strings = ['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut', 'Från', 'Till', 'Veckomönster', '7A', 'Matematik', '08:10', '09:10', long];
      const col = (i: number) => String.fromCharCode(65 + i);
      let sheetRows = `<row r="1">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<c r="${col(i)}1" t="s"><v>${i}</v></c>`).join('')}</row>`;
      for (let r = 2; r <= rows + 1; r += 1) {
        sheetRows += `<row r="${r}"><c r="A${r}" t="s"><v>8</v></c><c r="B${r}" t="s"><v>9</v></c><c r="C${r}" t="s"><v>12</v></c><c r="D${r}" t="s"><v>10</v></c><c r="E${r}" t="s"><v>11</v></c><c r="F${r}" t="s"><v>12</v></c><c r="G${r}" t="s"><v>12</v></c><c r="H${r}" t="s"><v>12</v></c></row>`;
      }
      return writeZip([
        { name: '_rels/.rels', data: b(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
        { name: 'xl/workbook.xml', data: b(`<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
        { name: 'xl/_rels/workbook.xml.rels', data: b(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`) },
        { name: 'xl/sharedStrings.xml', data: b(`<?xml version="1.0"?><sst xmlns="${NS}">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`) },
        { name: 'xl/worksheets/sheet1.xml', data: b(`<?xml version="1.0"?><worksheet xmlns="${NS}"><sheetData>${sheetRows}</sheetData></worksheet>`) },
      ]);
    }

    it.each([200, 1000, 5000])('%i rows that all echo a 32 767-character string answer in kilobytes, not gigabytes', (rows) => {
      const { result, ms } = millis(() => readUpload('TABLE_XLSX', [{ name: 'a.xlsx', bytes: sharedStringBook(rows, 'x'.repeat(32_767)) }]));
      expect(ms).toBeLessThan(BOUND_MS * 2);
      expect(result!.problems.length).toBeLessThanOrEqual(MAX_PROBLEMS + 1);
      expect(JSON.stringify(result).length).toBeLessThan(200_000);
    });

    it('says how many problems it left out', () => {
      const parsed = readUpload('TABLE_XLSX', [{ name: 'a.xlsx', bytes: sharedStringBook(2000, 'x'.repeat(5000)) }]);
      expect(parsed.problems.at(-1)!.message).toMatch(/Ytterligare \d+ problem visas inte/);
    });
  });

  describe('Untis: the periods the school types in (H4)', () => {
    it.each([100, 400, 1600, 1990])('a line of a number, %i blanks and an x', (n) => {
      expect(millis(() => parsePeriods(`1${' '.repeat(n)}x`)).ms).toBeLessThan(BOUND_MS);
    });

    it.each([[300, 300], [600, 600], [660, 1330]])('a line of a number, %i blanks, a time, %i blanks and an x', (a, c) => {
      expect(millis(() => parsePeriods(`1${' '.repeat(a)}08:10${' '.repeat(c)}x`)).ms).toBeLessThan(BOUND_MS);
    });

    it.each(['-', ' -', '- ', '–', '0', '1:'])('a line of %j repeated up to the limit', (filler) => {
      expect(millis(() => parsePeriods(filler.repeat(Math.floor(1990 / filler.length)))).ms).toBeLessThan(BOUND_MS);
    });

    it('still reads the periods a school types', () => {
      expect(parsePeriods('1 08:10-09:10\n2 09:20 - 10:20\n3\t10:30–11:30')).toEqual([
        { number: 1, start: '08:10', end: '09:10' },
        { number: 2, start: '09:20', end: '10:20' },
        { number: 3, start: '10:30', end: '11:30' },
      ]);
    });

    it('refuses a line too long to be a period, naming it, without trying a pattern on it', () => {
      expect(() => parsePeriods(`1 08:10${' '.repeat(100)}09:10`)).toThrow(/rad 1/);
    });
  });

  describe('Untis: the week field of GPU002 (H4)', () => {
    const row = (group: string, n: number) => {
      const f = new Array<string>(45).fill('');
      f[0] = String(n);
      f[4] = '"7A"';
      f[5] = '"AB"';
      f[6] = '"Matematik"';
      f[11] = `"${group}"`;
      return f.join(',');
    };
    const gpu001 = (n: number) => Array.from({ length: n }, (_v, i) => `${i + 1},"7A","AB","Matematik","",1,${480 + (i % 100) * 5},01:00`).join('\r\n');

    it.each([' ', '-', ' -', 'A ', '- A', 'A-B '])('300 rows whose field is %j repeated up to its length', (filler) => {
      const group = filler.repeat(Math.floor(1990 / filler.length));
      const gpu002 = Array.from({ length: 300 }, (_v, i) => row(group, i + 1)).join('\r\n');
      expect(millis(() => readUntisGpu({ gpu001: gpu001(300), gpu002 })).ms).toBeLessThan(BOUND_MS);
    });
  });
});
