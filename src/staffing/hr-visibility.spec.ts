import { Role } from '../auth/enums/role.enum';
import { testUser } from '../../test/utils/prisma-mock';
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

  it("is one list of the post's HR columns for the post and for its versions", () => {
    expect(EMPLOYMENT_HR_FIELDS).toEqual(['employmentForm', 'firstTeacherPercent', 'lecturerPercent', 'maxTeachingDaysPerWeek']);
    const row = Object.fromEntries(EMPLOYMENT_HR_FIELDS.map((field) => [field, 1]));
    const hidden = hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0, ...row }) as Record<string, unknown>;
    expect(EMPLOYMENT_HR_FIELDS.filter((field) => hidden[field] !== null)).toEqual([]);
    const changes = EMPLOYMENT_HR_FIELDS.map((field) => ({ field, before: 1, after: 2 }));
    expect(hideHrChanges(changes).filter((change) => change.before !== null || change.after !== null)).toEqual([]);
  });

  it('leaves a change of the days out of a version whole, where a percentage is said to have changed', () => {
    /*
     * The days are null on most posts. "Ändrad, dolt" on exactly the versions
     * where they moved would tell the reader which teacher has a limit.
     */
    expect(
      hideHrChanges([
        { field: 'employmentPercent', before: 100, after: 80 },
        { field: 'maxTeachingDaysPerWeek', before: null, after: 4 },
        { field: 'signature', before: 'A', after: 'B' },
      ]),
    ).toEqual([
      { field: 'employmentPercent', before: null, after: null, hrHidden: true },
      { field: 'signature', before: 'A', after: 'B' },
    ]);
    expect(hideHrChanges([{ field: 'maxTeachingDaysPerWeek', before: 4, after: 3 }])).toEqual([]);
  });

  it('keeps that a percentage changed in a version, without its values', () => {
    expect(
      hideHrChanges([
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
});
