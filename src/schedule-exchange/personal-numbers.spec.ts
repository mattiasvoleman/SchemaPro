/**
 * No personnummer out of any reader (the user's decision of 2026-11-05: Rastra
 * reads, stores and echoes none).
 *
 * A matrix, from the review of PR #256: nine ways to write a personnummer or a
 * samordningsnummer, put into every field a reader reads, in all four formats,
 * and the whole of what comes back (the lessons, the problems, the notes, the
 * label of a lesson and the refusal that names it) searched for any of its
 * digits. The cell-level rule is also pinned: a row with such a value in a
 * field that is read is NOT read, whatever the value would have meant.
 *
 * A column, element or field whose NAME says personnummer is dropped unread in
 * every reader; that is pinned in each reader's own spec and not repeated here.
 */
import { writeAscXml } from './asc-xml';
import { writeCsv } from './csv';
import { smallSchoolDocument } from './__fixtures__/documents';
import { readUpload } from './exchange-files';
import { indexContext, labelOf, resolveLesson, type PlanContext } from './exchange-plan';
import { hasPersonalNumber } from './file-safety';
import { LESSON_TABLE_HEADER, lessonsToTable } from './lesson-table';
import { writeUntisGpu } from './untis-gpu';
import { writeXlsx } from './xlsx';

const doc = smallSchoolDocument();
const ctx: PlanContext = {
  year: { id: 'y', name: '2026/2027', start: '2026-08-17', end: '2027-06-11', numbering: 'NIOARIG' },
  groups: doc.groups.map((g, i) => ({ id: 'g' + i, name: g.name, kind: g.kind, gradeLevel: g.gradeLevel, halfOfId: null })),
  subjects: doc.subjects.map((s, i) => ({ id: 's' + i, name: s.name, code: s.code })),
  rooms: doc.rooms.map((r, i) => ({ id: 'r' + i, name: r, code: null })),
  teachers: [
    { id: 't0', firstName: 'Anna', lastName: 'Berg', email: 'anna.berg@skolan.example', signature: 'ABE', isActive: true },
    { id: 't1', firstName: 'Bo', lastName: 'Lund', email: 'bo.lund@skolan.example', signature: 'BLU', isActive: true },
  ],
  existing: [], frames: [], rasts: [], lunch: null, servings: [], sittings: [], requirements: [], blocks: [], spans: new Map(),
};
const idx = indexContext(ctx);

const FORMS: Record<string, string> = {
  'ÅÅÅÅMMDD-NNNN': '19800101-1234',
  ÅÅMMDDNNNN: '8001011234',
  ÅÅÅÅMMDDNNNN: '198001011234',
  'ÅÅMMDD-NNNN': '800101-1234',
  'samordning ÅÅÅÅMMDD-NNNN': '19800181-1234',
  'samordning ÅÅMMDDNNNN': '8001811234',
  'inbäddad "Namn ÅÅÅÅMMDD-NNNN"': 'Anna Berg 19800101-1234',
  'parentes "(ÅÅMMDD-NNNN)"': '(800101-1234)',
  'med mellanslag "ÅÅÅÅMMDD - NNNN"': '19800101 - 1234',
};
/** Any digit run of any form: the dates and the last four, whatever stands between them. */
const DIGITS = /1980\D{0,3}01\D{0,3}01|8001\D{0,3}(01|81)|800101|1234/;

/**
 * The spellings the second review of PR #256 found outside the first shape:
 * other separators, invisible and no-break characters, line breaks, fullwidth
 * digits, spaces between digits, and the date written as a date. The control
 * characters (a line break, a tab) cannot sit inside a field of a DIF line, so
 * the Untis block takes only the ones that can.
 */
const MORE_FORMS: Record<string, string> = {
  'mellanslag mellan datum och nummer': '19800101 1234',
  'hårt blanksteg': '800101\u00a01234',
  'smalt hårt blanksteg': '800101\u202f1234',
  'tre mellanslag': '800101   1234',
  punkt: '800101.1234',
  snedstreck: '800101/1234',
  understreck: '800101_1234',
  'minustecken U+2212': '800101\u22121234',
  'nollbreddstecken': '800101\u200b1234',
  'mjukt bindestreck': '800101\u00ad1234',
  'fullbreddssiffror': '\uff18\uff10\uff10\uff11\uff10\uff11\uff0d\uff11\uff12\uff13\uff14',
  'siffror åtskilda av mellanslag': '8 0 0 1 0 1 1 2 3 4',
  'ÅÅÅÅ MM DD NNNN': '1980 01 01 1234',
  'ÅÅÅÅ-MM-DD-NNNN': '1980-01-01-1234',
  'ÅÅÅÅ-MM-DD NNNN': '1980-01-01 1234',
  'ÅÅ-MM-DD-NNNN': '80-01-01-1234',
  'ord direkt före och efter': 'abc8001011234xyz',
  'i en anteckning': 'Se anteckning: 19800101-1234 (vikarie)',
};
const CONTROL_FORMS: Record<string, string> = {
  radbrytning: '800101\n1234',
  CRLF: '800101\r\n1234',
  'radbrytning efter streck': '19800101-\n1234',
  tabb: '800101\t1234',
};

type Parsed = ReturnType<typeof readUpload>;

/** Every string that could reach the answer from one read, and one resolution of each lesson. */
function everythingOut(parsed: Parsed): string[] {
  const out: string[] = [JSON.stringify(parsed)];
  for (const l of parsed.lessons) {
    out.push(labelOf(l));
    const r = resolveLesson(l, idx, ctx);
    if ('refusals' in r) for (const x of r.refusals) out.push(x.detail, JSON.stringify(x.params));
  }
  return out;
}

function leaks(pn: string, parsed: Parsed): string[] {
  return everythingOut(parsed).filter((s) => s.includes(pn) || DIGITS.test(s) || hasPersonalNumber(s));
}

const header = [...LESSON_TABLE_HEADER];
const base = lessonsToTable(doc)[1]!;
const col = (name: string) => header.indexOf(name);
const upload = (format: 'TABLE_CSV' | 'TABLE_XLSX', rows: string[][]) =>
  readUpload(format, [format === 'TABLE_CSV' ? { name: 'a.csv', bytes: Buffer.from(writeCsv(rows), 'utf8') } : { name: 'a.xlsx', bytes: writeXlsx(rows, { sheetName: 'S' }) }]);

describe('no personnummer out of any reader', () => {
  it('has a control: the untouched export reads clean, so a leak below is the matrix’s own doing', () => {
    for (const format of ['TABLE_CSV', 'TABLE_XLSX'] as const) {
      const parsed = upload(format, [header, base]);
      expect(parsed.lessons).toHaveLength(1);
      expect(leaks('19800101-1234', parsed)).toEqual([]);
    }
  });

  describe('the flat table, CSV and Excel', () => {
    const fields = ['Klass/grupp', 'Ämne', 'Lärare', 'Lärarnamn', 'Lärare e-post', 'Lärar-id', 'Sal', 'Dag', 'Start', 'Slut', 'Från', 'Till', 'Veckomönster', 'Block', 'Lektions-id', 'Längd', 'Ämneskod', 'Medlärare', 'Ytterligare klasser'];
    it.each(fields)('%s', (field) => {
      for (const [formName, pn] of Object.entries(FORMS)) {
        const row = [...base];
        if (['Lärare', 'Lärarnamn', 'Lärare e-post', 'Lärar-id'].includes(field)) for (const f of ['Lärare', 'Lärarnamn', 'Lärare e-post', 'Lärar-id']) row[col(f)] = '';
        row[col(field)] = pn;
        for (const format of ['TABLE_CSV', 'TABLE_XLSX'] as const) {
          const parsed = upload(format, [header, row]);
          expect({ format, form: formName, leaked: leaks(pn, parsed).map((s) => s.slice(0, 120)) }).toEqual({ format, form: formName, leaked: [] });
          // The cell is read, so the row is not: the number is neither kept nor guessed around.
          expect({ format, form: formName, lessons: parsed.lessons.length }).toEqual({ format, form: formName, lessons: 0 });
          expect(parsed.problems.length).toBeGreaterThan(0);
        }
      }
    });

    it('does not cite a column header that is itself a number, nor one that names it', () => {
      for (const [formName, pn] of Object.entries(FORMS)) {
        for (const hdr of ['Personnummer', 'Pers.nr', 'PNR', 'Samordningsnummer', 'Lärare personnr (ÅÅMMDD-NNNN)', pn]) {
          const parsed = upload('TABLE_CSV', [[...header, hdr], [...base, pn]]);
          expect({ form: formName, hdr, leaked: leaks(pn, parsed).map((s) => s.slice(0, 120)) }).toEqual({ form: formName, hdr, leaked: [] });
          // The other columns are the file’s and are read; the column of numbers is not.
          expect(parsed.lessons).toHaveLength(1);
        }
      }
    });

    it('reads a row whose unread column holds a number, and drops the number', () => {
      const parsed = upload('TABLE_CSV', [[...header, 'Personnummer'], [...base, '19800101-1234']]);
      expect(parsed.lessons).toHaveLength(1);
      expect(JSON.stringify(parsed)).not.toContain('1234');
    });
  });

  describe('Untis GPU001 and GPU002', () => {
    const files = writeUntisGpu(doc);
    const lines001 = files.gpu001.split('\r\n');
    const lines002 = files.gpu002.split('\r\n');
    const read = (gpu001: string[], gpu002: string[]) =>
      readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes: Buffer.from(gpu001.join('\r\n')) }, { name: 'GPU002.TXT', bytes: Buffer.from(gpu002.join('\r\n')) }]);

    const gpu001: Array<[string, number]> = [['klass', 1], ['lärare', 2], ['ämne', 3], ['sal', 4], ['dag', 5], ['Stunde', 6], ['längd', 7], ['löpnummer', 0], ['fält 9', 8]];
    it.each(gpu001)('GPU001 %s', (_label, at) => {
      for (const [formName, pn] of Object.entries(FORMS)) {
        const l1 = [...lines001];
        const f = l1[0]!.split(',');
        while (f.length <= at) f.push('');
        f[at] = [0, 5, 6, 7].includes(at) ? pn : `"${pn}"`;
        l1[0] = f.join(',');
        const parsed = read(l1, lines002);
        expect({ form: formName, leaked: leaks(pn, parsed).map((s) => s.slice(0, 120)) }).toEqual({ form: formName, leaked: [] });
      }
    });

    const gpu002: Array<[string, number]> = [['grupp (fält 12)', 11], ['klass', 4], ['lärare', 5], ['ämne', 6], ['elevgrupp (fält 42)', 41]];
    it.each(gpu002)('GPU002 %s', (_label, at) => {
      for (const [formName, pn] of Object.entries(FORMS)) {
        const l2 = [...lines002];
        const f = l2[0]!.split(',');
        f[at] = `"${pn}"`;
        l2[0] = f.join(',');
        const parsed = read(lines001, l2);
        expect({ form: formName, leaked: leaks(pn, parsed).map((s) => s.slice(0, 120)) }).toEqual({ form: formName, leaked: [] });
      }
    });
  });

  describe('aSc XML', () => {
    const asc = writeAscXml(doc);
    const read = (xml: string) => readUpload('ASC_XML', [{ name: 'a.xml', bytes: Buffer.from(xml, 'utf8') }]);
    const bare = asc
      .replace(/(<teacher [^>]*?)short="[^"]*"/g, '$1short=""')
      .replace(/(<teacher [^>]*?)name="[^"]*"/g, '$1name=""')
      .replace(/(<teacher [^>]*?)email="[^"]*"/g, '$1email=""');
    const cases: Array<[string, (pn: string) => string]> = [
      ['teacher short', (pn) => bare.replace(/(<teacher [^>]*?short=")(")/, `$1${pn}$2`)],
      ['teacher name', (pn) => bare.replace(/(<teacher [^>]*?name=")(")/, `$1${pn}$2`)],
      ['teacher email', (pn) => bare.replace(/(<teacher [^>]*?email=")(")/, `$1${pn}$2`)],
      ['class name', (pn) => asc.replace(/(<class [^>]*?name=")[^"]*(")/, `$1${pn}$2`)],
      ['subject name', (pn) => asc.replace(/(<subject [^>]*?name=")[^"]*(")/, `$1${pn}$2`)],
      ['classroom name', (pn) => asc.replace(/(<classroom [^>]*?name=")[^"]*(")/, `$1${pn}$2`)],
      ['period starttime', (pn) => asc.replace(/(<period [^>]*?starttime=")[^"]*(")/, `$1${pn}$2`)],
      ['an attribute named personnummer', (pn) => asc.replace(/<teacher /, `<teacher personnummer="${pn}" `)],
      ['an attribute with an unrelated name', (pn) => asc.replace(/<teacher /, `<teacher skolid="${pn}" `)],
      ['card id', (pn) => asc.replace(/<card /, `<card id="${pn}" `)],
    ];
    it('has a control: the untouched file reads clean', () => {
      expect(leaks('19800101-1234', read(asc))).toEqual([]);
      expect(read(asc).lessons.length).toBeGreaterThan(0);
    });
    it.each(cases)('%s', (_label, make) => {
      for (const [formName, pn] of Object.entries(FORMS)) {
        const parsed = read(make(pn));
        expect({ form: formName, leaked: leaks(pn, parsed).map((s) => s.slice(0, 120)) }).toEqual({ form: formName, leaked: [] });
      }
    });
  });
  describe('spellings outside the first shape (the second review)', () => {
    const tableFields = ['Klass/grupp', 'Ämne', 'Lärare', 'Lärarnamn', 'Lärare e-post', 'Sal', 'Dag', 'Start', 'Slut', 'Från', 'Till', 'Veckomönster', 'Block', 'Längd', 'Ämneskod', 'Medlärare', 'Ytterligare klasser'];

    it.each(tableFields)('the flat table, %s: every spelling makes the row unreadable and is in no answer', (field) => {
      for (const [formName, pn] of Object.entries({ ...MORE_FORMS, ...CONTROL_FORMS })) {
        const row = [...base];
        if (['Lärare', 'Lärarnamn', 'Lärare e-post'].includes(field)) for (const f of ['Lärare', 'Lärarnamn', 'Lärare e-post', 'Lärar-id']) row[col(f)] = '';
        row[col(field)] = pn;
        for (const format of ['TABLE_CSV', 'TABLE_XLSX'] as const) {
          const parsed = upload(format, [header, row]);
          expect({ format, form: formName, leaked: leaks(pn, parsed).map((x) => x.slice(0, 120)) }).toEqual({ format, form: formName, leaked: [] });
          expect({ format, form: formName, lessons: parsed.lessons.length }).toEqual({ format, form: formName, lessons: 0 });
        }
      }
    });

    it('the block column, which is stored, takes none of them', () => {
      for (const [formName, pn] of Object.entries({ ...MORE_FORMS, ...CONTROL_FORMS })) {
        const row = [...base];
        row[col('Block')] = pn;
        const parsed = upload('TABLE_CSV', [header, row]);
        expect({ form: formName, lessons: parsed.lessons.map((l) => l.block) }).toEqual({ form: formName, lessons: [] });
      }
    });

    it('Untis, in the fields a DIF line can hold', () => {
      const files = writeUntisGpu(doc);
      const lines001 = files.gpu001.split('\r\n');
      for (const [formName, pn] of Object.entries(MORE_FORMS)) {
        for (const at of [1, 2, 3, 4]) {
          const l1 = [...lines001];
          const f = l1[0]!.split(',');
          f[at] = `"${pn}"`;
          l1[0] = f.join(',');
          const parsed = readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes: Buffer.from(l1.join('\r\n')) }, { name: 'GPU002.TXT', bytes: Buffer.from(files.gpu002) }]);
          expect({ form: formName, at, leaked: leaks(pn, parsed).map((x) => x.slice(0, 120)) }).toEqual({ form: formName, at, leaked: [] });
        }
      }
    });

    it('aSc, in a name that is copied into a lesson', () => {
      const xml = writeAscXml(doc);
      for (const [formName, pn] of Object.entries({ ...MORE_FORMS, ...CONTROL_FORMS })) {
        const escaped = pn.replace(/\r/g, '&#13;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
        for (const element of ['class', 'subject', 'classroom']) {
          const evil = xml.replace(new RegExp(`(<${element} [^>]*?name=")[^"]*(")`), `$1${escaped}$2`);
          const parsed = readUpload('ASC_XML', [{ name: 'a.xml', bytes: Buffer.from(evil, 'utf8') }]);
          expect({ form: formName, element, leaked: leaks(pn, parsed).map((x) => x.slice(0, 120)) }).toEqual({ form: formName, element, leaked: [] });
        }
      }
    });
  });
});
