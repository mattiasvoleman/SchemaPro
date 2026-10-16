import { Role } from '../auth/enums/role.enum';
import { testUser } from '../../test/utils/prisma-mock';
import { hideHr, hideHrChanges, readsHr } from './hr-visibility';

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
