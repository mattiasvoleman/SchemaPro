import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import { testUser } from '../../test/utils/prisma-mock';
import { DUTY_FIELDS, EMPLOYMENT_FIELDS, PERIOD_FIELDS, diffLogEntry } from './employment-log-diff';
import { EMPLOYMENT_HR_FIELDS, hideHr, hideHrChanges, readsHr } from './hr-visibility';

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
    // Left out whole: null on most posts (the days, the limit's pair), or what the post withholds (the note).
    const LEFT_OUT = [
      'maxTeachingDaysPerWeek',
      'maxConsecutiveTeachingMinutes',
      'consecutiveBreakMinutes',
      'noteChanged',
    ];
    const PLACED = [...SHOWN.map(([field]) => field), ...SAID, ...LEFT_OUT];

    /** The keys the latest app.teacher_staffing_log removes from a row before it is logged. */
    const stripped = (): string[] => {
      const root = join(__dirname, '..', '..', 'prisma', 'migrations');
      for (const dir of readdirSync(root).filter((name) => !name.endsWith('.toml')).sort().reverse()) {
        const sql = readFileSync(join(root, dir, 'migration.sql'), 'utf8');
        if (!/FUNCTION app\.teacher_staffing_log\(\) RETURNS trigger/.test(sql)) continue;
        const list = /stripped text\[\] := ARRAY\[([^\]]*)\]/.exec(sql);
        if (!list) throw new Error(`${dir} replaces app.teacher_staffing_log without a strip list this spec can read`);
        return [...list[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
      }
      throw new Error('no migration defines app.teacher_staffing_log');
    };

    it('places every field the diff knows in exactly one list', () => {
      expect([...PLACED].sort()).toEqual([...EMPLOYMENT_FIELDS].sort());
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
});
