import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SchoolForm } from '@prisma/client';
import {
  buildScbFile,
  inScbFile,
  largestRemainder,
  scbColumnApplies,
  scbColumnOf,
  scbValue,
  SCB_COLUMNS,
  SCB_PEDPERS_2026,
  SCB_SYSTEM_VERSION,
  type ScbEmployment,
  type ScbFileInput,
  type ScbTeacher,
} from './scb-pedpers';

type Assignment = ScbTeacher['assignments'][number];

const assignment = (overrides: Partial<Assignment>): Assignment => ({
  subjectId: 's-ma',
  subjectName: 'Matematik',
  groupName: '7A',
  gradeSpan: { min: 7, max: 7 },
  timeMinutesPerWeek: 240,
  ...overrides,
});

const post = (overrides: Partial<ScbEmployment> = {}): ScbEmployment => ({
  employmentPercent: 100,
  reductionPercent: 0,
  teachingTargetMinutesPerWeek: null,
  signature: null,
  employmentForm: 'TILLSVIDARE',
  firstTeacherPercent: null,
  lecturerPercent: null,
  ...overrides,
});

const teacher = (userId: string, overrides: Partial<ScbTeacher> = {}): ScbTeacher => ({
  userId,
  employment: post({ signature: userId.toUpperCase() }),
  assignments: [assignment({})],
  ...overrides,
});

const period = (validFrom: string, validTo: string | null, employmentPercent: number, reductionPercent = 0) => ({
  validFrom,
  validTo,
  employmentPercent,
  reductionPercent,
  teachingTargetMinutesPerWeek: null,
});

const people = new Map([
  ['t-anna', { firstName: 'Anna', lastName: 'Öberg' }],
  ['t-bo', { firstName: 'Bo', lastName: 'Alm' }],
  ['t-vik', { firstName: 'Vera', lastName: 'Vikarie' }],
]);

const subjects = [
  { id: 's-ma', nationalCode: 'MA', code: 'MA', name: 'Matematik' },
  { id: 's-en', nationalCode: 'EN', code: 'EN', name: 'Engelska' },
  { id: 's-no', nationalCode: 'NO', code: 'NO', name: 'NO' },
  { id: 's-est', nationalCode: 'EST', code: 'EST', name: 'Estetisk verksamhet' },
  { id: 's-sl', nationalCode: 'SL', code: 'SL', name: 'Slöjd' },
];
// One skolenhet, F–9: the common case.
const NORRA = { id: 'u-norra', name: 'Norra skolan', code: '12345678', gradeFrom: 0, gradeTo: 9 };
const grundskola = new Map<number, SchoolForm>([1, 2, 3, 4, 5, 6, 7, 8, 9].map((grade) => [grade, 'GRUNDSKOLA']));

const input = (overrides: Partial<ScbFileInput>): ScbFileInput => ({
  exportDate: '2026-10-15',
  year: { name: '2026/27', startDate: '2026-08-17', endDate: '2027-06-11' },
  schoolName: 'Norra skolan',
  teachers: [],
  firstTeacherDuties: [],
  subjects,
  schoolFormByGrade: grundskola,
  people,
  adminIds: new Set(),
  units: [NORRA],
  ...overrides,
});

const col = (name: string) => SCB_COLUMNS.indexOf(name as (typeof SCB_COLUMNS)[number]);
const byName = (rows: string[][]) => new Map(rows.map((row) => [row[col('PersonNamn')], row]));

describe('the SCB column table', () => {
  it("holds SCB's 80 variables in SCB's order, as the 2026-05-07 datafilsbeskrivning lists them", () => {
    expect(SCB_COLUMNS).toHaveLength(80);
    expect(new Set(SCB_COLUMNS).size).toBe(80);
    expect(SCB_COLUMNS.slice(0, 9)).toEqual([
      'System', 'Datum', 'Version', 'SkolenhetsKod', 'PersonNr', 'PersonNamn', 'Verksamhetstyp', 'SkolenhetNamn', 'AnstForm',
    ]);
    expect(SCB_COLUMNS[20]).toBe('OmfLarare');
    expect(SCB_COLUMNS[25]).toBe('ForsteLarare');
    expect(SCB_COLUMNS[26]).toBe('Lektor');
    expect(SCB_COLUMNS[27]).toBe('Undervisning');
    expect(SCB_COLUMNS[79]).toBe('OmfSprakochk');
    expect(SCB_PEDPERS_2026.specVersionDate).toBe('2026-05-07');
  });

  it("applies SCB's matrix: Estetisk and the ämnesområden only on anpassad grundskola, no subjects on förskoleklass", () => {
    expect(scbColumnApplies('OmfEstetisk', '6')).toBe(false);
    expect(scbColumnApplies('OmfEstetisk', '11')).toBe(true);
    expect(scbColumnApplies('OmfKommunikation', '4')).toBe(false);
    expect(scbColumnApplies('OmfSamiska', '5')).toBe(true);
    expect(scbColumnApplies('OmfSamiska', '11')).toBe(false);
    expect(scbColumnApplies('OmfMatematik', '1')).toBe(false);
    expect(scbColumnApplies('Undervisning', '1')).toBe(false);
    expect(scbColumnApplies('OmfLarare', '1')).toBe(true);
    expect(scbColumnApplies('ForsteLarare', '1')).toBe(true);
    expect(scbColumnApplies('Lektor', '12')).toBe(true);
  });

  it("states SchemaPro's own release in column 3, at most SCB's 15 characters", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { version: string };
    expect(SCB_SYSTEM_VERSION).toBe(pkg.version);
    expect(SCB_SYSTEM_VERSION.length).toBeLessThanOrEqual(15);
  });

  it('maps national codes to SCB columns, Svenska/SvA and moderna språk by the school’s subject', () => {
    expect(scbColumnOf({ nationalCode: 'MA', code: 'MA', name: 'Matematik' })).toBe('OmfMatematik');
    expect(scbColumnOf({ nationalCode: 'SV_SVA', code: 'SV', name: 'Svenska' })).toBe('OmfSvenska');
    expect(scbColumnOf({ nationalCode: 'SV_SVA', code: 'SVA', name: 'Svenska 2' })).toBe('OmfSVA');
    expect(scbColumnOf({ nationalCode: 'SV_SVA', code: null, name: 'Svenska som andraspråk' })).toBe('OmfSVA');
    expect(scbColumnOf({ nationalCode: 'M2', code: 'M2SP', name: 'Spanska' })).toBe('OmfSpanska');
    expect(scbColumnOf({ nationalCode: 'M2', code: 'M2', name: 'Kinesiska' })).toBe('OmfOvrigtSprak');
    expect(scbColumnOf({ nationalCode: 'NO', code: 'NO', name: 'NO' })).toBeNull();
    expect(scbColumnOf({ nationalCode: null, code: 'MT', name: 'Mentorstid' })).toBeNull();
  });

  it('shares a whole by largest remainder, summing to it', () => {
    expect(largestRemainder([1, 1, 1], 100)).toEqual([34, 33, 33]);
    expect(largestRemainder([38, 37], 10)).toEqual([5, 5]);
    expect(largestRemainder([0, 0], 10)).toEqual([0, 0]);
  });
});

describe('the text SCB takes', () => {
  it('is no header, semicolons, CRLF after every line, no byte order mark, 80 values a line', () => {
    const file = buildScbFile(input({ teachers: [teacher('t-anna'), teacher('t-bo')] }));
    expect(file.text.charCodeAt(0)).not.toBe(0xfeff);
    expect(file.text.endsWith('\r\n')).toBe(true);
    const lines = file.text.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.split(';').length === 80)).toBe(true);
    // Line 1 is a person, not SCB's variable names.
    expect(lines[0]).not.toContain('SkolenhetsKod');
    expect(lines[0]!.startsWith('SchemaPro;2026-10-15;0.1.0;12345678;;Bo Alm;6;Norra skolan;T;')).toBe(true);
    // The rows the CSV is written from are the text's, value for value.
    expect(file.rows.map((row) => row.join(';'))).toEqual(lines);
    expect(file.columns).toEqual(SCB_COLUMNS);
    expect(file.filename).toBe('scb-pedagogisk-personal-2026-27.txt');
    expect(file.matdatum).toBe('2026-10-15');
  });

  it('keeps a semicolon or a line break in a name from breaking a line, and cuts names to 100 characters', () => {
    const long = 'Å'.repeat(120);
    const file = buildScbFile(
      input({
        people: new Map([['t-anna', { firstName: 'Anna;Lisa', lastName: 'Öberg\r\nHolm' }]]),
        units: [{ ...NORRA, name: long }],
        teachers: [teacher('t-anna')],
      }),
    );
    const [row] = file.rows;
    expect(row![col('PersonNamn')]).toBe('Anna Lisa Öberg Holm');
    expect([...row![col('SkolenhetNamn')]!]).toHaveLength(100);
    expect(file.text.split('\r\n')).toHaveLength(2);
    expect(scbValue('a;\tb\u0000c  d ')).toBe('a b c d');
  });

  it('never writes PersonNr, nor anything about legitimation', () => {
    const file = buildScbFile(input({ teachers: [teacher('t-anna'), teacher('t-bo')] }));
    expect(file.rows.every((row) => row[col('PersonNr')] === '')).toBe(true);
    expect(file.text.toLowerCase()).not.toContain('legitim');
    // PersonNr is said once, by the download, not listed per row.
    expect(file.missing).toEqual([]);
  });
});

describe('SCB Pedagogisk personal, the rows', () => {
  it('fills what SchemaPro knows: unit, verksamhetstyp, AnstForm, OmfLarare and the subjects', () => {
    const file = buildScbFile(
      input({
        teachers: [
          teacher('t-anna', {
            employment: post({ employmentPercent: 80, employmentForm: 'VISSTID' }),
            assignments: [
              assignment({ subjectId: 's-ma', timeMinutesPerWeek: 600 }),
              assignment({ subjectId: 's-en', subjectName: 'Engelska', timeMinutesPerWeek: 300 }),
            ],
          }),
        ],
      }),
    );
    const [row] = file.rows;
    expect(row).toHaveLength(80);
    expect(row![col('System')]).toBe('SchemaPro');
    expect(row![col('Datum')]).toBe('2026-10-15');
    expect(row![col('SkolenhetsKod')]).toBe('12345678');
    expect(row![col('SkolenhetNamn')]).toBe('Norra skolan');
    expect(row![col('PersonNamn')]).toBe('Anna Öberg');
    expect(row![col('Verksamhetstyp')]).toBe('6');
    expect(row![col('AnstForm')]).toBe('V');
    expect(row![col('OmfLarare')]).toBe('80');
    expect(row![col('Undervisning')]).toBe('J');
    expect(row![col('OmfMatematik')]).toBe('67');
    expect(row![col('OmfEngelska')]).toBe('33');
    expect(row![col('ForsteLarare')]).toBe('');
    expect(row![col('Lektor')]).toBe('');
    expect(file.notices).toEqual([]);
    expect(file.missing).toEqual([]);
  });

  it('lists a post with no anställningsform yet, and leaves AnstForm empty rather than guessing', () => {
    const file = buildScbFile(input({ teachers: [teacher('t-anna', { employment: post({ employmentForm: null }) })] }));
    expect(file.rows[0]![col('AnstForm')]).toBe('');
    expect(file.missing).toEqual([
      { line: 1, name: 'Anna Öberg', unit: 'Norra skolan', verksamhetstyp: '6', fields: ['ANSTFORM'] },
    ]);
  });

  it('reports a post that changes during the year as it is on the mätdatum, 15 oktober, and says so', () => {
    const withPeriods = (userId: string, periods: ReturnType<typeof period>[]) =>
      teacher(userId, { employment: post({ periods }) });
    const file = buildScbFile(
      input({
        teachers: [
          // 80 % from 1 October (15 October falls in it), 100 % again from January.
          withPeriods('t-anna', [period('2026-10-01', '2026-12-31', 80)]),
          // 100 % on 15 October; 50 % only from the spring.
          withPeriods('t-bo', [period('2027-01-11', null, 50)]),
        ],
      }),
    );
    const rows = byName(file.rows);
    expect(rows.get('Anna Öberg')![col('OmfLarare')]).toBe('80');
    expect(rows.get('Bo Alm')![col('OmfLarare')]).toBe('100');
    expect(file.notices).toContainEqual({ code: 'POST_CHANGES', params: { name: 'Anna Öberg', date: '2026-10-15' } });
  });

  describe('tjänstledig on the mätdatum', () => {
    it('is L for a full leave of 30 days or more: the post held, one row, no subjects, nothing to list', () => {
      const file = buildScbFile(
        input({
          teachers: [
            // 12 October – 18 December: 68 days.
            teacher('t-vik', {
              employment: post({ employmentForm: null, firstTeacherPercent: 20, periods: [period('2026-10-12', '2026-12-18', 100, 100)] }),
              assignments: [
                assignment({ subjectId: 's-ma', timeMinutesPerWeek: 600 }),
                assignment({ subjectId: 's-no', subjectName: 'NO', groupName: '5A', gradeSpan: { min: 5, max: 5 }, timeMinutesPerWeek: 200 }),
              ],
            }),
          ],
        }),
      );
      expect(file.rows).toHaveLength(1);
      const [row] = file.rows;
      expect(row![col('AnstForm')]).toBe('L');
      expect(row![col('Verksamhetstyp')]).toBe('6');
      expect(row![col('OmfLarare')]).toBe('100');
      expect(row![col('ForsteLarare')]).toBe('20');
      expect(row![col('Undervisning')]).toBe('');
      expect(row![col('OmfMatematik')]).toBe('');
      // L needs no anställningsform, and no subjects: nothing is missing.
      expect(file.missing).toEqual([]);
      expect(file.notices).toContainEqual({ code: 'LEAVE', params: { name: 'Vera Vikarie', from: '2026-10-12', to: '2026-12-18' } });
      expect(file.notices.map((entry) => entry.code)).not.toContain('LEFT_OUT');
    });

    it('is L for a post wholly reduced all year, measured from the läsår’s first day', () => {
      const file = buildScbFile(input({ teachers: [teacher('t-anna', { employment: post({ reductionPercent: 100 }) })] }));
      expect(file.rows[0]![col('AnstForm')]).toBe('L');
      expect(file.rows[0]![col('OmfLarare')]).toBe('100');
      expect(file.notices).toContainEqual({ code: 'LEAVE', params: { name: 'Anna Öberg', from: '2026-08-17', to: '2027-06-11' } });
    });

    it('counts adjacent full nedsättningar as one leave', () => {
      // 1–20 October and 21 October – 10 November: 41 days together, 20 and 21 apart.
      const file = buildScbFile(
        input({
          teachers: [
            teacher('t-anna', {
              employment: post({
                periods: [period('2026-10-01', '2026-10-20', 100, 100), period('2026-10-21', '2026-11-10', 80, 80)],
              }),
            }),
          ],
        }),
      );
      expect(file.rows[0]![col('AnstForm')]).toBe('L');
      expect(file.notices).toContainEqual({ code: 'LEAVE', params: { name: 'Anna Öberg', from: '2026-10-01', to: '2026-11-10' } });
    });

    it('is tjänstgörande with the general post for a full leave shorter than 30 days, and says so', () => {
      // 6–31 October: 26 days. Before and after it, an 80 % post.
      const file = buildScbFile(
        input({
          teachers: [
            teacher('t-anna', {
              employment: post({
                employmentPercent: 80,
                periods: [period('2026-10-06', '2026-10-31', 80, 80)],
              }),
            }),
          ],
        }),
      );
      const [row] = file.rows;
      expect(row![col('AnstForm')]).toBe('T');
      expect(row![col('OmfLarare')]).toBe('80');
      expect(row![col('OmfMatematik')]).toBe('100');
      expect(file.notices).toContainEqual({ code: 'SHORT_LEAVE', params: { name: 'Anna Öberg', from: '2026-10-06', to: '2026-10-31' } });
    });
  });

  it('is 29 days of leave short and 30 long, as SCB draws the line', () => {
    const leave = (to: string) =>
      buildScbFile(
        input({ teachers: [teacher('t-anna', { employment: post({ periods: [period('2026-10-01', to, 100, 100)] }) })] }),
      ).rows[0]![col('AnstForm')];
    expect(leave('2026-10-29')).toBe('T');
    expect(leave('2026-10-30')).toBe('L');
  });

  describe('karriärtjänster', () => {
    it('writes the post’s förstelärare and lektor shares, spread over the rows like the omfattning', () => {
      const file = buildScbFile(
        input({
          teachers: [
            teacher('t-anna', {
              employment: post({ employmentPercent: 75, firstTeacherPercent: 10, lecturerPercent: 5 }),
              assignments: [assignment({ subjectId: 's-ma', gradeSpan: { min: 6, max: 7 }, timeMinutesPerWeek: 600 })],
            }),
          ],
        }),
      );
      expect(file.rows.map((row) => [row[col('Verksamhetstyp')], row[col('OmfLarare')], row[col('ForsteLarare')], row[col('Lektor')]])).toEqual([
        ['5', '38', '5', '3'],
        ['6', '37', '5', '2'],
      ]);
    });

    it('lists a förstelärare uppdrag on the mätdatum with no share on the post, on each of the teacher’s rows', () => {
      const file = buildScbFile(
        input({
          firstTeacherDuties: [
            { userId: 't-anna', validFrom: null, validTo: null },
            // Ended before the mätdatum: nothing to state.
            { userId: 't-bo', validFrom: null, validTo: '2026-09-30' },
          ],
          teachers: [teacher('t-anna'), teacher('t-bo')],
        }),
      );
      expect(file.missing).toEqual([
        { line: 2, name: 'Anna Öberg', unit: 'Norra skolan', verksamhetstyp: '6', fields: ['FORSTELARARE_ANDEL'] },
      ]);
    });

    it('fills the share from the post whether or not an uppdrag says förstelärare', () => {
      const file = buildScbFile(
        input({ teachers: [teacher('t-anna', { employment: post({ firstTeacherPercent: 20 }) })] }),
      );
      expect(file.rows[0]![col('ForsteLarare')]).toBe('20');
      expect(file.missing).toEqual([]);
    });
  });

  it('names a post with no planned teaching: SCB wants a verksamhetstyp on every row', () => {
    // A speciallärare, or a teacher whose timplansposter are not staffed yet.
    const file = buildScbFile(input({ teachers: [teacher('t-anna', { assignments: [], employment: post({ lecturerPercent: 50 }) })] }));
    const [row] = file.rows;
    expect(row![col('OmfLarare')]).toBe('100');
    expect(row![col('Verksamhetstyp')]).toBe('');
    expect(row![col('Undervisning')]).toBe('N');
    expect(row![col('Lektor')]).toBe('50');
    expect(file.notices).toContainEqual({ code: 'NO_TEACHING', params: { name: 'Anna Öberg' } });
    expect(file.missing).toEqual([
      { line: 1, name: 'Anna Öberg', unit: 'Norra skolan', verksamhetstyp: '', fields: ['VERKSAMHETSTYP'] },
    ]);
  });

  it('splits a group across stages by its grades, and the post by largest remainder summing to the whole', () => {
    const file = buildScbFile(
      input({
        teachers: [
          teacher('t-anna', {
            employment: post({ employmentPercent: 75 }),
            assignments: [assignment({ subjectId: 's-ma', gradeSpan: { min: 6, max: 7 }, timeMinutesPerWeek: 600 })],
          }),
        ],
      }),
    );
    expect(file.rows.map((row) => row[col('Verksamhetstyp')])).toEqual(['5', '6']);
    expect(file.rows.map((row) => row[col('OmfLarare')])).toEqual(['38', '37']);
    expect(file.rows.map((row) => row[col('OmfMatematik')])).toEqual(['100', '100']);
  });

  it("leaves out and names NO and a column SCB does not collect for the row's verksamhetstyp, rescaling the rest", () => {
    const file = buildScbFile(
      input({
        teachers: [
          teacher('t-anna', {
            assignments: [
              assignment({ subjectId: 's-ma', timeMinutesPerWeek: 300 }),
              assignment({ subjectId: 's-no', subjectName: 'NO', timeMinutesPerWeek: 300 }),
              assignment({ subjectId: 's-est', subjectName: 'Estetisk verksamhet', timeMinutesPerWeek: 300 }),
            ],
          }),
        ],
      }),
    );
    const [row] = file.rows;
    expect(row![col('OmfMatematik')]).toBe('100');
    expect(row![col('OmfEstetisk')]).toBe('');
    expect(file.notices).toEqual([
      { code: 'LEFT_OUT', params: { name: 'Anna Öberg', line: 'NO 7A' } },
      { code: 'LEFT_OUT', params: { name: 'Anna Öberg', line: 'Estetisk verksamhet 7A' } },
    ]);
  });

  it('lists a grundskola row whose every subject is left out: SCB wants subjects for OmfLarare > 0', () => {
    const file = buildScbFile(
      input({ teachers: [teacher('t-anna', { assignments: [assignment({ subjectId: 's-no', subjectName: 'NO' })] })] }),
    );
    expect(file.rows[0]![col('Undervisning')]).toBe('');
    expect(file.missing).toEqual([
      { line: 1, name: 'Anna Öberg', unit: 'Norra skolan', verksamhetstyp: '6', fields: ['AMNEN'] },
    ]);
  });

  it('merges again until no row is 0, and keeps a post above 0 at 1 % at least', () => {
    // 10 % over Ma 7A and Mu in 5A, 2A and F: the first pass merges F; the
    // rows left share 9, 1 and 0, and the 0 merges in its turn.
    const file = buildScbFile(
      input({
        subjects: [...subjects, { id: 's-mu', nationalCode: 'MU', code: 'MU', name: 'Musik' }],
        teachers: [
          teacher('t-anna', {
            employment: post({ employmentPercent: 10 }),
            assignments: [
              assignment({ subjectId: 's-ma', timeMinutesPerWeek: 160 }),
              assignment({ subjectId: 's-mu', subjectName: 'Musik', groupName: '5A', gradeSpan: { min: 5, max: 5 }, timeMinutesPerWeek: 12 }),
              assignment({ subjectId: 's-mu', subjectName: 'Musik', groupName: '2A', gradeSpan: { min: 2, max: 2 }, timeMinutesPerWeek: 12 }),
              assignment({ subjectId: 's-mu', subjectName: 'Musik', groupName: 'F', gradeSpan: { min: 0, max: 0 }, timeMinutesPerWeek: 10 }),
            ],
          }),
          teacher('t-bo', { employment: post({ employmentPercent: 0.4 }), assignments: [] }),
        ],
      }),
    );
    const omf = file.rows.map((row) => [row[col('PersonNamn')], row[col('Verksamhetstyp')], row[col('OmfLarare')]]);
    expect(omf.every(([, , share]) => share !== '0')).toBe(true);
    expect(omf.filter(([name]) => name === 'Anna Öberg').reduce((sum, [, , share]) => sum + Number(share), 0)).toBe(10);
    expect(omf.find(([name]) => name === 'Bo Alm')?.[2]).toBe('1');
  });

  it('names an absence of 30 days or more over the mätdatum, whatever its reason, and nothing shorter', () => {
    const file = buildScbFile(
      input({
        teachers: [teacher('t-anna'), teacher('t-bo'), teacher('t-vik')],
        absences: [
          { userId: 't-anna', from: '2026-09-28', to: '2026-11-30' },
          // 29 days over the mätdatum: a short leave, reported as in service.
          { userId: 't-bo', from: '2026-10-01', to: '2026-10-29' },
          // Long, but after the mätdatum.
          { userId: 't-vik', from: '2026-10-16', to: '2026-12-31' },
        ],
      }),
    );
    expect(file.notices).toEqual([
      { code: 'LONG_ABSENCE', params: { name: 'Anna Öberg', from: '2026-09-28', to: '2026-11-30' } },
    ]);
    // The file still says what the post says: L is read from the nedsättning.
    expect(byName(file.rows).get('Anna Öberg')![col('AnstForm')]).toBe('T');
  });

  it("codes an anpassad grundskola row 10–12 from the year's timplan, where Estetisk verksamhet is collected", () => {
    const file = buildScbFile(
      input({
        schoolFormByGrade: new Map<number, SchoolForm>([[5, 'ANPASSAD_GRUNDSKOLA_AMNEN']]),
        teachers: [
          teacher('t-anna', {
            assignments: [
              assignment({ subjectId: 's-est', subjectName: 'Estetisk verksamhet', gradeSpan: { min: 5, max: 5 }, timeMinutesPerWeek: 200 }),
              assignment({ subjectId: 's-sl', subjectName: 'Slöjd', gradeSpan: { min: 5, max: 5 }, timeMinutesPerWeek: 200 }),
            ],
          }),
        ],
      }),
    );
    const [row] = file.rows;
    expect(row![col('Verksamhetstyp')]).toBe('11');
    expect(row![col('OmfEstetisk')]).toBe('50');
    expect(row![col('OmfSlojd')]).toBe('50');
  });

  it('gives förskoleklass no subjects and no Undervisning, merges a row whose share rounds to 0', () => {
    const file = buildScbFile(
      input({
        teachers: [
          teacher('t-anna', {
            employment: post({ employmentPercent: 50 }),
            assignments: [
              assignment({ subjectId: 's-ma', gradeSpan: { min: 0, max: 0 }, groupName: 'FK', timeMinutesPerWeek: 1000 }),
              // 4 of 1004 minutes: 0 % of a 50 % post — merged into the FK row.
              assignment({ subjectId: 's-ma', gradeSpan: { min: 7, max: 7 }, timeMinutesPerWeek: 4 }),
            ],
          }),
        ],
      }),
    );
    expect(file.rows).toHaveLength(1);
    expect(file.rows[0]![col('Verksamhetstyp')]).toBe('1');
    expect(file.rows[0]![col('OmfLarare')]).toBe('50');
    expect(file.rows[0]![col('Undervisning')]).toBe('');
    expect(file.rows[0]![col('OmfMatematik')]).toBe('');
    expect(file.missing).toEqual([]);
  });

  it('uses undervisningstid and not räknad tid, names a reduction and an admin, lists a missing post', () => {
    const file = buildScbFile(
      input({
        teachers: [
          teacher('t-anna', {
            employment: post({ reductionPercent: 20 }),
            assignments: [
              assignment({ subjectId: 's-sl', subjectName: 'Slöjd', timeMinutesPerWeek: 200 }),
              assignment({ subjectId: 's-ma', timeMinutesPerWeek: 200 }),
            ],
          }),
          teacher('t-bo', { employment: null }),
        ],
        adminIds: new Set(['t-anna']),
      }),
    );
    const rows = byName(file.rows);
    const anna = rows.get('Anna Öberg')!;
    expect(anna[col('OmfLarare')]).toBe('80');
    expect(anna[col('OmfSlojd')]).toBe('50');
    expect(anna[col('OmfMatematik')]).toBe('50');
    const bo = rows.get('Bo Alm')!;
    expect(bo[col('OmfLarare')]).toBe('');
    expect(bo[col('AnstForm')]).toBe('');
    expect(bo.join(';')).not.toContain('NaN');
    // Bo Alm sorts first: his notice comes first.
    expect(file.notices.map((entry) => entry.code)).toEqual(['NO_POST', 'REDUCTION', 'ADMIN']);
    expect(file.missing).toEqual([
      { line: 1, name: 'Bo Alm', unit: 'Norra skolan', verksamhetstyp: '6', fields: ['OMFATTNING'] },
    ]);
  });

  it('leaves specialskola uncoded and a grade without a timplan as grundskola, with notices; flags a year that is not HT 2026', () => {
    const file = buildScbFile(
      input({
        year: { name: '2027/28', startDate: '2027-08-16', endDate: '2028-06-09' },
        schoolFormByGrade: new Map<number, SchoolForm>([[8, 'SPECIALSKOLA']]),
        teachers: [
          teacher('t-anna', {
            assignments: [
              assignment({ gradeSpan: { min: 8, max: 8 }, timeMinutesPerWeek: 100 }),
              assignment({ gradeSpan: { min: 4, max: 4 }, timeMinutesPerWeek: 100 }),
            ],
          }),
        ],
      }),
    );
    expect(file.rows.map((row) => row[col('Verksamhetstyp')])).toEqual(['5', '']);
    expect(file.matdatum).toBe('2027-10-15');
    expect(file.notices.map((entry) => entry.code)).toEqual(['NOT_HT2026', 'FORM_WITHOUT_CODE', 'GRADE_WITHOUT_TIMPLAN']);
    expect(file.missing.map((entry) => [entry.line, entry.fields])).toEqual([[2, ['VERKSAMHETSTYP']]]);
  });

  it('reports a vikarie with teaching and no post, and leaves out a person with neither', () => {
    expect(inScbFile(teacher('t-x', { employment: null }))).toBe(true);
    expect(inScbFile(teacher('t-x', { employment: null, assignments: [] }))).toBe(false);
    expect(inScbFile(teacher('t-x', { assignments: [] }))).toBe(true);
    const file = buildScbFile(input({ teachers: [teacher('t-x', { employment: null, assignments: [] })] }));
    expect(file.rows).toEqual([]);
    expect(file.text).toBe('');
  });

  it('names a teacher whose account is closed, and keeps the row for the school to judge', () => {
    const file = buildScbFile(
      input({
        people: new Map([
          ['t-anna', { firstName: 'Anna', lastName: 'Öberg', inactiveSince: '2026-09-30' }],
          ['t-bo', { firstName: 'Bo', lastName: 'Alm', inactiveSince: null }],
        ]),
        teachers: [teacher('t-anna'), teacher('t-bo')],
      }),
    );
    expect(file.rows).toHaveLength(2);
    expect(file.notices).toEqual([
      { code: 'INACTIVE', params: { name: 'Bo Alm', date: 'none' } },
      { code: 'INACTIVE', params: { name: 'Anna Öberg', date: '2026-09-30' } },
    ]);
  });

  it('names a teacher the roster cannot by the post’s signature', () => {
    const file = buildScbFile(input({ teachers: [teacher('t-unknown', { employment: post({ signature: 'XYZ' }) })] }));
    expect(file.rows[0]![col('PersonNamn')]).toBe('XYZ');
  });

  describe('skolenheter', () => {
    const F6 = { id: 'u-f6', name: 'Norra F–6', code: '11111111', gradeFrom: 0, gradeTo: 6 };
    const U79 = { id: 'u-79', name: 'Norra 7–9', code: '22222222', gradeFrom: 7, gradeTo: 9 };
    const split = teacher('t-anna', {
      assignments: [
        assignment({ subjectId: 's-ma', groupName: '6A', gradeSpan: { min: 6, max: 6 }, timeMinutesPerWeek: 300 }),
        assignment({ subjectId: 's-ma', groupName: '7A', gradeSpan: { min: 7, max: 7 }, timeMinutesPerWeek: 300 }),
      ],
    });

    it('writes one row per skolenhet a teacher teaches in, each with its code and name', () => {
      const file = buildScbFile(input({ units: [U79, F6], teachers: [split] }));
      expect(
        file.rows.map((row) => [row[col('SkolenhetsKod')], row[col('SkolenhetNamn')], row[col('Verksamhetstyp')], row[col('OmfLarare')]]),
      ).toEqual([
        ['11111111', 'Norra F–6', '5', '50'],
        ['22222222', 'Norra 7–9', '6', '50'],
      ]);
      expect(file.notices).toEqual([]);
    });

    it('splits a group across two units by its grades', () => {
      const file = buildScbFile(
        input({
          units: [F6, U79],
          teachers: [teacher('t-anna', { assignments: [assignment({ gradeSpan: { min: 6, max: 7 }, timeMinutesPerWeek: 600 })] })],
        }),
      );
      expect(file.rows.map((row) => [row[col('SkolenhetsKod')], row[col('OmfLarare')]])).toEqual([
        ['11111111', '50'],
        ['22222222', '50'],
      ]);
    });

    it('says so, and lists the rows, when the school has no unit, a unit has no code, or a grade lies in no span', () => {
      const none = buildScbFile(input({ units: [], teachers: [split] }));
      expect(none.rows.map((row) => [row[col('SkolenhetsKod')], row[col('SkolenhetNamn')]])).toEqual([
        ['', 'Norra skolan'],
        ['', 'Norra skolan'],
      ]);
      expect(none.notices).toContainEqual({ code: 'NO_SCHOOL_UNIT', params: {} });
      expect(none.missing.map((entry) => entry.fields)).toEqual([['SKOLENHETSKOD'], ['SKOLENHETSKOD']]);

      const noCode = buildScbFile(input({ units: [{ ...F6, code: null }, U79], teachers: [split] }));
      expect(noCode.rows[0]![col('SkolenhetsKod')]).toBe('');
      expect(noCode.notices).toEqual([{ code: 'UNIT_WITHOUT_CODE', params: { unit: 'Norra F–6' } }]);
      expect(noCode.missing).toEqual([
        { line: 1, name: 'Anna Öberg', unit: 'Norra F–6', verksamhetstyp: '5', fields: ['SKOLENHETSKOD'] },
      ]);

      // 7–9 only from 8: grade 7 lies in no span and falls to the first unit.
      const gap = buildScbFile(input({ units: [F6, { ...U79, gradeFrom: 8 }], teachers: [split] }));
      expect(gap.notices).toEqual([{ code: 'GRADE_WITHOUT_UNIT', params: { grade: 7, unit: 'Norra F–6' } }]);
      expect(gap.rows.map((row) => row[col('SkolenhetsKod')])).toEqual(['11111111', '11111111']);
    });

    it("merges a share that rounds to nothing into its own unit's row, not another unit's", () => {
      // 7A (7–9) is the largest row; 3A's few minutes of Engelska (F–6, åk 1–3)
      // round to no share and belong with 6A, the other F–6 row.
      const file = buildScbFile(
        input({
          units: [F6, U79],
          teachers: [
            teacher('t-anna', {
              assignments: [
                assignment({ subjectId: 's-ma', groupName: '7A', gradeSpan: { min: 7, max: 7 }, timeMinutesPerWeek: 600 }),
                assignment({ subjectId: 's-ma', groupName: '6A', gradeSpan: { min: 6, max: 6 }, timeMinutesPerWeek: 200 }),
                assignment({ subjectId: 's-en', subjectName: 'Engelska', groupName: '3A', gradeSpan: { min: 3, max: 3 }, timeMinutesPerWeek: 4 }),
              ],
            }),
          ],
        }),
      );
      expect(
        file.rows.map((row) => [row[col('SkolenhetsKod')], row[col('Verksamhetstyp')], row[col('OmfMatematik')], row[col('OmfEngelska')]]),
      ).toEqual([
        ['11111111', '5', '98', '2'],
        ['22222222', '6', '100', ''],
      ]);
    });

    it('puts a post with no planned teaching in the first unit', () => {
      const file = buildScbFile(input({ units: [U79, F6], teachers: [teacher('t-anna', { assignments: [] })] }));
      expect(file.rows[0]![col('SkolenhetsKod')]).toBe('11111111');
    });
  });
});
