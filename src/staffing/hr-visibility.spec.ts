import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import { testUser } from '../../test/utils/prisma-mock';
import { DUTY_FIELDS, EMPLOYMENT_FIELDS, PERIOD_FIELDS, diffLogEntry } from './employment-log-diff';
import {
  EMPLOYMENT_HR_FIELDS,
  HR_SAID_IN_A_POST,
  NOT_HR_IN_A_POST,
  POST_READ_AS_IS,
  POST_READ_NULLED,
  hideHr,
  hideHrChanges,
  readsHr,
} from './hr-visibility';

describe('hr-visibility', () => {
  it('lets rektor, full and HR-läs read tjänst %, and no other administrator', () => {
    expect(readsHr(testUser())).toBe(true);
    expect(readsHr(testUser({ adminProfile: 'REKTOR' }))).toBe(true);
    expect(readsHr(testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: true }))).toBe(true);
    expect(readsHr(testUser({ adminProfile: 'EXPEDITION', hrRead: true }))).toBe(true);
    expect(readsHr(testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false }))).toBe(false);
    expect(readsHr(testUser({ adminProfile: 'EXPEDITION' }))).toBe(false);
    // An administrator without a profile reads none, rather than all.
    expect(readsHr(testUser({ adminProfile: undefined }))).toBe(false);
  });

  it("answers for administrators only: a teacher's own post is filtered elsewhere", () => {
    expect(readsHr(testUser({ role: Role.TEACHER }))).toBe(true);
  });

  it('nulls the two percentages and a note, says so, and keeps the rest', () => {
    expect(
      hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 20, signature: 'KOL', note: 'skäl' }),
    ).toEqual({ userId: 'u', employmentPercent: null, reductionPercent: null, signature: 'KOL', note: null, hrHidden: true });
    expect(hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0 })).not.toHaveProperty('note');
  });

  it("takes the post's periods with them: when and how a post changes is HR data too", () => {
    const period = { validFrom: '2026-11-01', validTo: null, employmentPercent: 50, reductionPercent: 0 };
    expect(hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0, periods: [period] })).toMatchObject({
      employmentPercent: null,
      periods: [],
      hrHidden: true,
    });
    expect(hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0 })).not.toHaveProperty('periods');
  });

  it("nulls SCB's three where a post carries them: anställningsform and the karriärtjänst shares are HR data", () => {
    expect(
      hideHr({
        userId: 'u',
        employmentPercent: 80,
        reductionPercent: 0,
        signature: 'KOL',
        employmentForm: 'VISSTID',
        firstTeacherPercent: 20,
        lecturerPercent: 10,
      }),
    ).toEqual({
      userId: 'u',
      employmentPercent: null,
      reductionPercent: null,
      signature: 'KOL',
      employmentForm: null,
      firstTeacherPercent: null,
      lecturerPercent: null,
      hrHidden: true,
    });
    // A load row has none of them, and gets none.
    expect(hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0 })).not.toHaveProperty('employmentForm');
  });

  it('nulls deltid in days where a post carries it, and gives a row without it none (20261123090000)', () => {
    expect(
      hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0, signature: 'KOL', maxTeachingDaysPerWeek: 4 }),
    ).toEqual({
      userId: 'u',
      employmentPercent: null,
      reductionPercent: null,
      signature: 'KOL',
      maxTeachingDaysPerWeek: null,
      hrHidden: true,
    });
    // A load row (LoadEmployment) does not carry the days, and is not given them.
    expect(hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0 })).not.toHaveProperty('maxTeachingDaysPerWeek');
  });

  it('nulls the limit on teaching in a row where a post carries it, both columns, and gives a row without it none (20261218090000)', () => {
    expect(
      hideHr({
        userId: 'u',
        employmentPercent: 80,
        reductionPercent: 0,
        signature: 'KOL',
        maxConsecutiveTeachingMinutes: 180,
        consecutiveBreakMinutes: 30,
      }),
    ).toEqual({
      userId: 'u',
      employmentPercent: null,
      reductionPercent: null,
      signature: 'KOL',
      maxConsecutiveTeachingMinutes: null,
      consecutiveBreakMinutes: null,
      hrHidden: true,
    });
    // A load row does not carry the limit, and is not given it.
    const loadRow = hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0 });
    expect(loadRow).not.toHaveProperty('maxConsecutiveTeachingMinutes');
    expect(loadRow).not.toHaveProperty('consecutiveBreakMinutes');
  });

  it("is one list of the post's HR columns for the post and for its versions", () => {
    expect(EMPLOYMENT_HR_FIELDS).toEqual([
      'employmentForm',
      'firstTeacherPercent',
      'lecturerPercent',
      'maxTeachingDaysPerWeek',
      'maxConsecutiveTeachingMinutes',
      'consecutiveBreakMinutes',
      'payrollNumber',
    ]);
    const row = Object.fromEntries(EMPLOYMENT_HR_FIELDS.map((field) => [field, 1]));
    const hidden = hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0, ...row }) as Record<string, unknown>;
    expect(EMPLOYMENT_HR_FIELDS.filter((field) => hidden[field] !== null)).toEqual([]);
    const changes = EMPLOYMENT_HR_FIELDS.map((field) => ({ field, before: 1, after: 2 }));
    expect(hideHrChanges('EMPLOYMENT', changes).filter((change) => change.before !== null || change.after !== null)).toEqual([]);
  });

  it('leaves a change of the days out of a version whole, where a percentage is said to have changed', () => {
    /*
     * The days are null on most posts. "Ändrad, dolt" on exactly the versions
     * where they moved would tell the reader which teacher has a limit.
     */
    expect(
      hideHrChanges('EMPLOYMENT', [
        { field: 'employmentPercent', before: 100, after: 80 },
        { field: 'maxTeachingDaysPerWeek', before: null, after: 4 },
        { field: 'signature', before: 'A', after: 'B' },
      ]),
    ).toEqual([
      { field: 'employmentPercent', before: null, after: null, hrHidden: true },
      { field: 'signature', before: 'A', after: 'B' },
    ]);
    expect(hideHrChanges('EMPLOYMENT', [{ field: 'maxTeachingDaysPerWeek', before: 4, after: 3 }])).toEqual([]);
  });

  it('leaves a change of the limit on teaching in a row out of a version whole, both columns, where a percentage is said to have changed', () => {
    /*
     * The limit is null on most posts, like the days. "Ändrad, dolt" on exactly
     * the versions where it moved would tell the reader which teacher has one,
     * and a version that moved only one column of the pair (it cannot, but a
     * log row written by hand could) says nothing of it either.
     */
    expect(
      hideHrChanges('EMPLOYMENT', [
        { field: 'employmentPercent', before: 100, after: 80 },
        { field: 'maxConsecutiveTeachingMinutes', before: null, after: 180 },
        { field: 'consecutiveBreakMinutes', before: null, after: 30 },
        { field: 'signature', before: 'A', after: 'B' },
      ]),
    ).toEqual([
      { field: 'employmentPercent', before: null, after: null, hrHidden: true },
      { field: 'signature', before: 'A', after: 'B' },
    ]);
    expect(
      hideHrChanges('EMPLOYMENT', [
        { field: 'maxConsecutiveTeachingMinutes', before: 180, after: 150 },
        { field: 'consecutiveBreakMinutes', before: 30, after: 20 },
      ]),
    ).toEqual([]);
    expect(hideHrChanges('EMPLOYMENT', [{ field: 'consecutiveBreakMinutes', before: 30, after: null }])).toEqual([]);
  });

  it('keeps that a percentage changed in a version, without its values', () => {
    expect(
      hideHrChanges('EMPLOYMENT', [
        { field: 'employmentPercent', before: 100, after: 80 },
        { field: 'reductionPercent', before: 0, after: 20 },
        { field: 'employmentForm', before: null, after: 'VISSTID' },
        { field: 'firstTeacherPercent', before: 10, after: 20 },
        { field: 'lecturerPercent', before: 5, after: null },
        { field: 'signature', before: 'A', after: 'B' },
      ]),
    ).toEqual([
      { field: 'employmentPercent', before: null, after: null, hrHidden: true },
      { field: 'reductionPercent', before: null, after: null, hrHidden: true },
      { field: 'employmentForm', before: null, after: null, hrHidden: true },
      { field: 'firstTeacherPercent', before: null, after: null, hrHidden: true },
      { field: 'lecturerPercent', before: null, after: null, hrHidden: true },
      { field: 'signature', before: 'A', after: 'B' },
    ]);
  });

  /*
   * A VERSION OF A POST OR A PERIOD, FIELD BY FIELD. The log holds the row as
   * JSON less a strip list (app.teacher_staffing_log), so every column of the
   * table is in a version without anything but these lists to place it. The
   * lists are the decision for each, argued in hr-visibility.ts; a column that
   * is in none of them is left out, and the third test fails until somebody
   * has placed it.
   */
  describe('a version of a post, for a reader without HR-läs', () => {
    const said = (field: string) => ({ field, before: null, after: null, hrHidden: true });
    // Shown with its values: the post hands the column to this reader as well.
    const SHOWN: [string, unknown, unknown][] = [
      ['contractKind', 'FERIE', 'SEMESTER'],
      ['teachingTargetMinutesPerWeek', null, 1200],
      ['signature', 'ANN', 'ANS'],
    ];
    // Said to have changed, not to what: every post has a value.
    const SAID = ['employmentPercent', 'reductionPercent', 'employmentForm', 'firstTeacherPercent', 'lecturerPercent'];
    // Left out whole: null on most posts (the days, the limit's pair, Löne-id until the school writes one), or what
    // the post withholds (the note).
    const LEFT_OUT = [
      'maxTeachingDaysPerWeek',
      'maxConsecutiveTeachingMinutes',
      'consecutiveBreakMinutes',
      'payrollNumber',
      'noteChanged',
    ];
    const PLACED = [...SHOWN.map(([field]) => field), ...SAID, ...LEFT_OUT];

    /**
     * The keys the latest migration that defines app.teacher_staffing_log
     * removes from a row before it is logged. Throws, rather than reads an
     * older migration, when a newer one defines the function in a form this
     * cannot read: a guard that passed over it would go on checking the
     * columns against a list that is no longer the one in force.
     */
    const stripListOf = (migrations: { dir: string; sql: string }[]): string[] => {
      const definition = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+app\s*\.\s*"?teacher_staffing_log"?\s*\(/i;
      for (const { dir, sql } of [...migrations].sort((a, b) => b.dir.localeCompare(a.dir))) {
        if (!definition.test(sql)) continue;
        const list = /stripped\s+text\s*\[\s*\]\s*:=\s*ARRAY\s*\[([^\]]*)\]/i.exec(sql);
        if (!list) throw new Error(`${dir} replaces app.teacher_staffing_log without a strip list this spec can read`);
        return [...list[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
      }
      throw new Error('no migration defines app.teacher_staffing_log');
    };

    const stripped = (): string[] => {
      const root = join(__dirname, '..', '..', 'prisma', 'migrations');
      return stripListOf(
        readdirSync(root)
          .filter((name) => !name.endsWith('.toml'))
          .map((dir) => ({ dir, sql: readFileSync(join(root, dir, 'migration.sql'), 'utf8') })),
      );
    };

    describe('the guard that reads the strip list', () => {
      const fn = (header: string, list = "'schoolId','createdAt'") =>
        `${header}\nDECLARE\n  stripped text[] := ARRAY[${list}];\nBEGIN\n  RETURN NEW;\nEND;`;

      it('reads the newest definition, however it is laid out', () => {
        const older = { dir: '20261104090000_a', sql: fn('CREATE OR REPLACE FUNCTION app.teacher_staffing_log() RETURNS trigger AS $$', "'a'") };
        for (const header of [
          'CREATE OR REPLACE FUNCTION app.teacher_staffing_log()\nRETURNS trigger AS $$',
          'create or replace function app.teacher_staffing_log ( ) returns trigger as $$',
          'CREATE FUNCTION app."teacher_staffing_log"() RETURNS trigger AS $$',
        ]) {
          expect(stripListOf([older, { dir: '20261230000000_b', sql: fn(header, "'b','c'") }])).toEqual(['b', 'c']);
        }
      });

      it('reads a lowercase or spaced list too, and throws on a list it cannot read', () => {
        const header = 'CREATE OR REPLACE FUNCTION app.teacher_staffing_log() RETURNS trigger AS $$';
        expect(stripListOf([{ dir: '1', sql: fn(header).replace('stripped text[] := ARRAY[', 'stripped TEXT [ ] := array [') }])).toEqual([
          'schoolId',
          'createdAt',
        ]);
        expect(() =>
          stripListOf([{ dir: '1', sql: fn(header).replace('stripped text[] := ARRAY[', 'stripped text[] := ARRAY(SELECT 1) --[') }]),
        ).toThrow(/without a strip list/);
      });

      it('does not mistake the trigger function that writes the log for the one that strips it', () => {
        const write = {
          dir: '20261230000000_w',
          sql: 'CREATE OR REPLACE FUNCTION app.teacher_staffing_log_write() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$',
        };
        const strips = { dir: '20261104090000_s', sql: fn('CREATE OR REPLACE FUNCTION app.teacher_staffing_log() RETURNS trigger AS $$', "'x'") };
        expect(stripListOf([strips, write])).toEqual(['x']);
      });

      it('throws when no migration defines the function', () => {
        expect(() => stripListOf([{ dir: '1', sql: 'SELECT 1;' }])).toThrow(/no migration defines/);
      });

      it('reads the strip list of the migrations this repository has', () => {
        expect(stripped()).toEqual(expect.arrayContaining(['schoolId', 'createdAt', 'updatedAt']));
      });
    });

    it('places every field the diff knows in exactly one list', () => {
      expect([...PLACED].sort()).toEqual([...EMPLOYMENT_FIELDS].sort());
    });

    it('has no entry in its lists for a field the diff does not know: an allow list is not a pre-approval', () => {
      // Without this a name such as 'ssn' could sit in a list for years and
      // be shown, values and all, the day a column of that name is added.
      for (const list of [NOT_HR_IN_A_POST, HR_SAID_IN_A_POST]) {
        expect([...list].filter((field) => !(EMPLOYMENT_FIELDS as readonly string[]).includes(field))).toEqual([]);
      }
      expect([...NOT_HR_IN_A_POST].sort()).toEqual(SHOWN.map(([field]) => field).sort());
      expect([...HR_SAID_IN_A_POST].sort()).toEqual([...SAID].sort());
      expect([...NOT_HR_IN_A_POST].filter((field) => HR_SAID_IN_A_POST.has(field))).toEqual([]);
    });

    it('places every column of the post that the log holds, by the latest log function', () => {
      // Prisma's column list less the trigger's strip list, the identity the
      // diff leaves out, and the note: its text never enters, and
      // "noteChanged" says it was written (20261010090000).
      const identity = ['id', 'userId', 'academicYearId'];
      const logged = Object.keys(Prisma.TeacherEmploymentScalarFieldEnum)
        .filter((column) => ![...stripped(), ...identity, 'note'].includes(column))
        .concat('noteChanged');
      expect([...logged].sort()).toEqual([...PLACED].sort());
    });

    it('leaves out every column of a period that the log holds, the target too', () => {
      const identity = ['id', 'userId', 'academicYearId', 'employmentId'];
      const logged = Object.keys(Prisma.TeacherEmploymentPeriodScalarFieldEnum).filter(
        (column) => ![...stripped(), ...identity].includes(column),
      );
      expect([...logged].sort()).toEqual([...PERIOD_FIELDS].sort());
      expect(hideHrChanges('PERIOD', logged.map((field) => ({ field, before: 1, after: 2 })))).toEqual([]);
    });

    it.each(SHOWN)('shows %s with its values', (field, before, after) => {
      expect(hideHrChanges('EMPLOYMENT', [{ field, before, after }])).toEqual([{ field, before, after }]);
    });

    it.each(SAID)('says that %s changed, not to what', (field) => {
      expect(hideHrChanges('EMPLOYMENT', [{ field, before: 1, after: 2 }])).toEqual([said(field)]);
    });

    it.each(LEFT_OUT)('says nothing of %s', (field) => {
      expect(hideHrChanges('EMPLOYMENT', [{ field, before: null, after: 2 }])).toEqual([]);
    });

    it("leaves out a key no list knows, name and value: a column added after this code, or a gateway rolled back past it", () => {
      // Through the diff, as the service does: it hands every key it does not know on.
      const changes = diffLogEntry(
        'EMPLOYMENT',
        { id: 'e', userId: 'u', signature: 'ANN', employmentEndsOn: null, probation: false },
        { id: 'e', userId: 'u', signature: 'ANS', employmentEndsOn: '2027-06-15', probation: true },
      );
      expect(changes.map((change) => change.field)).toEqual(['signature', 'employmentEndsOn', 'probation']);
      const masked = hideHrChanges('EMPLOYMENT', changes);
      expect(masked).toEqual([{ field: 'signature', before: 'ANN', after: 'ANS' }]);
      expect(JSON.stringify(masked)).not.toMatch(/employmentEndsOn|probation|2027-06-15/);
    });

    it('hands over a whole row exactly as the lists say, the limit and the note out', () => {
      const row = {
        id: 'e',
        userId: 'u',
        academicYearId: 'y',
        employmentPercent: 80,
        reductionPercent: 10,
        contractKind: 'SEMESTER',
        employmentForm: 'TILLSVIDARE',
        firstTeacherPercent: 20,
        lecturerPercent: null,
        teachingTargetMinutesPerWeek: 1100,
        maxTeachingDaysPerWeek: 4,
        maxConsecutiveTeachingMinutes: 180,
        consecutiveBreakMinutes: 30,
        signature: 'ANN',
        noteChanged: true,
        employmentEndsOn: '2027-06-15',
      };
      const masked = hideHrChanges('EMPLOYMENT', diffLogEntry('EMPLOYMENT', null, row));
      expect(masked).toEqual([
        said('employmentPercent'),
        said('reductionPercent'),
        { field: 'contractKind', before: null, after: 'SEMESTER' },
        said('employmentForm'),
        said('firstTeacherPercent'),
        said('lecturerPercent'),
        { field: 'teachingTargetMinutesPerWeek', before: null, after: 1100 },
        { field: 'signature', before: null, after: 'ANN' },
      ]);
      // The two fields of the limit, #231's, are not in the answer, by name or by figure.
      expect(JSON.stringify(masked)).not.toMatch(/onsecutive|BreakMinutes|180|noteChanged/);
    });

    it("leaves out every field of a period, the dates and the target too: the allow list is the post's alone", () => {
      expect(
        hideHrChanges('PERIOD', [
          { field: 'validFrom', before: null, after: '2026-11-01' },
          { field: 'validTo', before: null, after: null },
          { field: 'employmentPercent', before: null, after: 80 },
          { field: 'teachingTargetMinutesPerWeek', before: null, after: 900 },
          { field: 'reason', before: null, after: 'föräldraledighet' },
        ]),
      ).toEqual([]);
    });

    it("leaves an uppdrag's version as it is: every administrator reads the duty row whole", () => {
      const changes = DUTY_FIELDS.map((field) => ({ field, before: null, after: 1 }));
      expect(hideHrChanges('DUTY', changes)).toEqual(changes);
    });

    it('leaves out an entity it does not know, like a period', () => {
      expect(hideHrChanges('SOMETHING_NEW' as never, [{ field: 'signature', before: 'A', after: 'B' }])).toEqual([]);
    });
  });

  /*
   * THE POST AS IT IS READ (list and PUT answer). The same principle as its
   * versions, and the same decision for each column: what the version shows
   * with its values the post hands over with them, what the version says or
   * leaves out the post hands over as null. The row is Prisma's, so a column
   * added to TeacherEmployments is in it the day the migration has run; here
   * it is left out until somebody has placed it.
   */
  describe('a post as it is read, for a reader without HR-läs', () => {
    /** The row as the service has it after toEmploymentResponse, every column of the model. */
    const post = (extra: Record<string, unknown> = {}) => ({
      id: 'e',
      schoolId: 's',
      userId: 'u',
      academicYearId: 'y',
      employmentPercent: 80,
      reductionPercent: 20,
      contractKind: 'SEMESTER',
      employmentForm: 'VISSTID',
      firstTeacherPercent: 20,
      lecturerPercent: 10,
      teachingTargetMinutesPerWeek: 1100,
      maxTeachingDaysPerWeek: 4,
      maxConsecutiveTeachingMinutes: 180,
      consecutiveBreakMinutes: 30,
      signature: 'ANN',
      note: 'Föräldraledig 20 %',
      payrollNumber: '4711-01',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-02T00:00:00.000Z'),
      periods: [{ validFrom: '2026-11-01', validTo: null, employmentPercent: 50, reductionPercent: 0 }],
      ...extra,
    });

    it('places every column of the model, the periods too, in the list that shows it or the list that nulls it', () => {
      const columns = Object.keys(Prisma.TeacherEmploymentScalarFieldEnum)
        // The SS12000 stretch key leaves through no API (toEmploymentResponse).
        .filter((column) => column !== 'ss12000StretchKey')
        .concat('periods');
      const placed = [...POST_READ_AS_IS, ...POST_READ_NULLED, 'periods'];
      expect([...placed].sort()).toEqual([...columns].sort());
      expect([...POST_READ_AS_IS].filter((column) => POST_READ_NULLED.has(column))).toEqual([]);
    });

    it("agrees with the post's versions, column by column", () => {
      // What a version shows with its values, the post shows with its values.
      for (const field of NOT_HR_IN_A_POST) expect(POST_READ_AS_IS.has(field)).toBe(true);
      // What a version says changed, or leaves out, the post nulls: a column
      // that is HR in the log is not handed over in the post. noteChanged is
      // the note's version, left out; the post nulls the note itself.
      const hrInTheLog = [...EMPLOYMENT_FIELDS].filter((field) => !NOT_HR_IN_A_POST.has(field));
      for (const field of hrInTheLog) {
        const column = field === 'noteChanged' ? 'note' : field;
        expect([field, POST_READ_NULLED.has(column)]).toEqual([field, true]);
        expect([field, POST_READ_AS_IS.has(column)]).toEqual([field, false]);
      }
    });

    it('hands over the known columns as it always did: the HR ones null, the rest with their values, hrHidden last', () => {
      expect(hideHr(post())).toEqual({
        id: 'e',
        schoolId: 's',
        userId: 'u',
        academicYearId: 'y',
        employmentPercent: null,
        reductionPercent: null,
        contractKind: 'SEMESTER',
        employmentForm: null,
        firstTeacherPercent: null,
        lecturerPercent: null,
        teachingTargetMinutesPerWeek: 1100,
        maxTeachingDaysPerWeek: null,
        maxConsecutiveTeachingMinutes: null,
        consecutiveBreakMinutes: null,
        signature: 'ANN',
        note: null,
        payrollNumber: null,
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-02T00:00:00.000Z'),
        periods: [],
        hrHidden: true,
      });
      expect(Object.keys(hideHr(post())).at(-1)).toBe('hrHidden');
    });

    it('is, for the columns it knows, what the deny list gave: the same JSON, key for key', () => {
      // The function this replaced, as a reference: it spread the row and nulled what it was told to.
      const denyList = (row: Record<string, unknown>) => ({
        ...row,
        employmentPercent: null,
        reductionPercent: null,
        ...('note' in row ? { note: null } : {}),
        ...('periods' in row ? { periods: [] } : {}),
        ...Object.fromEntries(EMPLOYMENT_HR_FIELDS.filter((field) => field in row).map((field) => [field, null])),
        hrHidden: true,
      });
      const { note: _note, periods: _periods, ...withoutNoteAndPeriods } = post();
      const loadRow = { userId: 'u', employmentPercent: 80, reductionPercent: 0, contractKind: 'FERIE', teachingTargetMinutesPerWeek: null, signature: null };
      for (const row of [post(), withoutNoteAndPeriods, loadRow, { ...loadRow, periods: [] }]) {
        expect(JSON.stringify(hideHr(row as never))).toEqual(JSON.stringify(denyList(row)));
      }
    });

    it('leaves out a column no list knows, name and value: one added to the model after this code', () => {
      const hidden = hideHr(post({ futureHrColumn: 'hemligt', employmentEndsOn: new Date('2027-06-15T00:00:00.000Z'), probation: false }));
      expect(Object.keys(hidden)).not.toEqual(expect.arrayContaining(['futureHrColumn']));
      expect(Object.keys(hidden).sort()).toEqual(Object.keys(hideHr(post())).sort());
      expect(JSON.stringify(hidden)).not.toMatch(/futureHrColumn|hemligt|employmentEndsOn|2027-06-15|probation/);
    });

    it('leaves out the stretch key even if a row still carried it, and puts nothing in its place', () => {
      expect(hideHr(post({ ss12000StretchKey: 'aaaaaaaa-0000-4000-8000-000000000001' }))).not.toHaveProperty('ss12000StretchKey');
    });

    it('nulls only what the row carries, as a load row without a note, a period list or the days has none of them', () => {
      const hidden = hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0, signature: 'KOL' });
      expect(hidden).toEqual({ userId: 'u', employmentPercent: null, reductionPercent: null, signature: 'KOL', hrHidden: true });
    });
  });
});
