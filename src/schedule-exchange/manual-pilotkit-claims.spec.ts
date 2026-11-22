import claims from './__fixtures__/manual-pilotkit-claims.json';
import { readUpload } from './exchange-files';
import { readAscXml } from './asc-xml';
import { readUntisGpu } from './untis-gpu';

/**
 * What the user manual's 3.8 says the Untis and aSc readers do (P1 Pilotkit), proved on the readers.
 *
 * The guide is read by a school that will do what it says, so each sentence about a reader has to be one the reader keeps. The
 * sentences are in __fixtures__/manual-pilotkit-claims.json, in the manual's words; web/lib/manual-pilotkit-readers.test.ts
 * requires each phrase to stand in the manual, and this requires each id to have a proof here and no proof to be without a
 * phrase. The readers' own specs prove the readers; this proves that what the guide says of them is what they do.
 */

const gpu001 = (...lines: string[]): string => lines.join('\r\n') + '\r\n';
const GRID = '1 08:10-09:10\n2 09:20-10:20';
const bytes = (text: string, encoding: BufferEncoding = 'utf8'): Buffer => Buffer.from(text, encoding);
const codes = (parsed: { problems: { code: string }[] }): string[] => parsed.problems.map((problem) => problem.code);

/** A GPU002 row of 45 fields with the fields the reader takes set: lesson number, class, teacher, subject, Gruppe, dates. */
function gpu002Row(over: { no: string; klass: string; teacher: string; subject: string; group?: string; from?: string; to?: string }): string {
  const fields = Array.from({ length: 45 }, () => '');
  fields[0] = over.no;
  fields[3] = `"${over.klass}"`;
  fields[4] = `"${over.teacher}"`;
  fields[5] = `"${over.subject}"`;
  fields[11] = over.group ?? '';
  fields[14] = over.from ?? '';
  fields[15] = over.to ?? '';
  return fields.join(',') + '\r\n';
}

/** A small valid aSc file whose one card has the given weeks and terms, with the termsdefs the test writes. */
function asc(weeks: string, terms: string, termsdefs: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<timetable ascttversion="2017.6.10" importtype="database" options="canadd,export:silent">
<periods options="canadd,export:silent" columns="period,starttime,endtime"><period period="1" starttime="8:10" endtime="9:10"/></periods>
<termsdefs columns="id,name,terms">${termsdefs}</termsdefs>
<subjects columns="id,name,short"><subject id="S1" name="Matematik" short="MA"/></subjects>
<teachers columns="id,name,short,email"><teacher id="T1" name="Anna Berg" short="ABE" email="anna@skolan.example"/></teachers>
<classes columns="id,name,short"><class id="C1" name="7A" short="7A"/></classes>
<classrooms columns="id,name,short"><classroom id="R1" name="K1" short="K1"/></classrooms>
<lessons columns="id,subjectid,classids,teacherids,classroomids,periodspercard,periodsperweek"><lesson id="L1" subjectid="S1" classids="C1" teacherids="T1" classroomids="R1" periodspercard="1" periodsperweek="1"/></lessons>
<cards columns="lessonid,classroomids,period,weeks,terms,days"><card lessonid="L1" classroomids="R1" period="1" weeks="${weeks}" terms="${terms}" days="10000"/></cards>
</timetable>`;
}
const ALL_TERMS = '<termsdef id="M1" name="Hela läsåret" terms="1"/>';

const PROOFS: Record<string, () => void> = {
  'untis-gpu001-required': () => {
    const only002 = gpu002Row({ no: '1', klass: '7A', teacher: 'ABE', subject: 'MA' });
    expect(() => readUpload('UNTIS_GPU', [{ name: 'GPU002.TXT', bytes: bytes(only002) }], { periods: GRID })).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: 'IMPORT_UNTIS_NO_GPU001' }) }),
    );
    // GPU001 alone is read: every lesson every week, all year, and the reader says GPU002 is missing.
    const parsed = readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes: bytes(gpu001('1,"7A","ABE","MA","K1",1,1,')) }], { periods: GRID });
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.notes.join(' ')).toContain('GPU002 saknas');
  },
  'untis-two-teachers': () => {
    const parsed = readUntisGpu({ gpu001: gpu001('1,"7A","ABE","MA","K1",1,1,', '1,"7A","BLU","MA","K1",1,1,', '2,"7A","ABE","SV","K1",2,1,', '2,"7A","BLU","SV","K1",2,1,', '2,"7A","CAN","SV","K1",2,1,') }, { periods: [{ number: 1, start: '08:10', end: '09:10' }] });
    expect(parsed.lessons.map((lesson) => [lesson.subject, lesson.teachers.map((teacher) => teacher.short)])).toEqual([['MA', ['ABE', 'BLU']]]);
    expect(codes(parsed)).toContain('GPU_TOO_MANY_TEACHERS');
  },
  'untis-ab-weeks': () => {
    const files = {
      gpu001: gpu001('1,"7A","ABE","MA","K1",1,1,', '2,"7A","ABE","SV","K1",2,1,'),
      gpu002: gpu002Row({ no: '1', klass: '7A', teacher: 'ABE', subject: 'MA', group: 'A-vecka', from: '20260817', to: '20261218' }) + gpu002Row({ no: '2', klass: '7A', teacher: 'ABE', subject: 'SV', group: 'B-vecka' }),
    };
    const parsed = readUntisGpu(files, { periods: [{ number: 1, start: '08:10', end: '09:10' }] });
    expect(parsed.lessons.map((lesson) => [lesson.subject, lesson.weeks, lesson.from, lesson.to])).toEqual([
      ['MA', 'ODD', '2026-08-17', '2026-12-18'],
      ['SV', 'EVEN', null, null],
    ]);
  },
  'untis-period-grid': () => {
    const file = gpu001('1,"7A","ABE","MA","K1",1,1,', '2,"7A","ABE","SV","K1",2,2,');
    const without = readUntisGpu({ gpu001: file });
    expect(without.lessons).toEqual([]);
    expect(codes(without)).toEqual(['GPU_UNKNOWN_PERIOD', 'GPU_UNKNOWN_PERIOD']);
    const withGrid = readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes: bytes(file) }], { periods: GRID });
    expect(withGrid.lessons.map((lesson) => [lesson.start, lesson.end])).toEqual([['08:10', '09:10'], ['09:20', '10:20']]);
  },
  'untis-encodings': () => {
    const line = gpu001('1,"7A","ABE","Idrott och hälsa","K1",1,1,');
    for (const encoding of ['utf8', 'latin1'] as const) {
      const parsed = readUpload('UNTIS_GPU', [{ name: 'GPU001.TXT', bytes: bytes(line, encoding) }], { periods: GRID });
      expect(parsed.lessons.map((lesson) => lesson.subject)).toEqual(['Idrott och hälsa']);
    }
  },
  'asc-first-week-odd': () => {
    expect(readAscXml(asc('10', '1', ALL_TERMS)).lessons.map((lesson) => lesson.weeks)).toEqual(['ODD']);
    expect(readAscXml(asc('01', '1', ALL_TERMS)).lessons.map((lesson) => lesson.weeks)).toEqual(['EVEN']);
    expect(readAscXml(asc('10', '1', ALL_TERMS)).notes.join(' ')).toContain('udda ISO-veckor');
  },
  'asc-rotation': () => {
    for (const weeks of ['100', '1100']) {
      const parsed = readAscXml(asc(weeks, '1', ALL_TERMS));
      expect(parsed.lessons).toEqual([]);
      expect(codes(parsed)).toEqual(['ASC_WEEKS_UNSUPPORTED']);
    }
  },
  'asc-term-span': () => {
    const named = (name: string) => `<termsdef id="T1" name="${name}" terms="10"/><termsdef id="T2" name="Resten" terms="01"/>`;
    const span = readAscXml(asc('1', '10', named('2026-08-17–2026-12-18')));
    expect(span.lessons.map((lesson) => [lesson.from, lesson.to])).toEqual([['2026-08-17', '2026-12-18']]);
    const plain = readAscXml(asc('1', '10', named('Term 1')));
    expect(plain.lessons.map((lesson) => [lesson.from, lesson.to])).toEqual([[null, null]]);
    expect(plain.notes.join(' ')).toContain('Term 1');
  },
};

describe('what the user manual says of the Untis and aSc readers (3.8)', () => {
  it('has a proof for every claim and a claim for every proof', () => {
    expect(Object.keys(PROOFS).sort()).toEqual(claims.claims.map((claim) => claim.id).sort());
  });

  it.each(claims.claims.map((claim): [string, string] => [claim.id, claim.phrase]))('%s: "%s"', (id) => {
    PROOFS[id]!();
  });
});
