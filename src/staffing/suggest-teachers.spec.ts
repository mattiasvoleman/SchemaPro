import { suggestTeachers } from './suggest-teachers';
import {
  DEFAULT_LOAD_POLICY,
  type LoadEmployment,
  type LoadInput,
  type LoadQualification,
  type LoadRequirement,
} from './teacher-load';

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MA = 'ma-subject';

const post = (userId: string, overrides: Partial<LoadEmployment> = {}): LoadEmployment => ({
  userId,
  employmentPercent: 100,
  reductionPercent: 0,
  contractKind: 'FERIE',
  teachingTargetMinutesPerWeek: null,
  signature: null,
  ...overrides,
});

const row = (id: string, overrides: Partial<LoadRequirement> = {}): LoadRequirement => ({
  id,
  subjectId: MA,
  subjectName: 'Matematik',
  studentGroupId: 'g-8a',
  groupName: '8A',
  teacherId: null,
  coTeacherId: null,
  lessonsPerWeek: 4,
  minutesPerLesson: 60,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  gradeSpan: { min: 8, max: 8 },
  ...overrides,
});

const qual = (userId: string, overrides: Partial<LoadQualification> = {}): LoadQualification => ({
  userId,
  subjectId: MA,
  minGradeLevel: 7,
  maxGradeLevel: 9,
  kind: 'LEGITIMATION',
  validFrom: null,
  validTo: null,
  ...overrides,
});

const input = (overrides: Partial<LoadInput> = {}): LoadInput => ({
  year: YEAR,
  policy: { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080 },
  employments: [post(ANNA), post(BO), post(CY)],
  requirements: [row('target')],
  qualifications: [],
  closures: [],
  duties: [],
  ...overrides,
});

const order = (result: ReturnType<typeof suggestTeachers>) => result.candidates.map((c) => c.userId);

describe('suggestTeachers', () => {
  it('ranks behörighet first, LEGITIMATION over BEHORIG over TILLATEN over none', () => {
    const result = suggestTeachers(
      input({
        employments: [post(ANNA), post(BO), post(CY), post(DAG)],
        qualifications: [qual(BO, { kind: 'TILLATEN' }), qual(CY, { kind: 'BEHORIG' }), qual(DAG)],
      }),
      'target',
      [ANNA, BO, CY, DAG],
    );
    expect(order(result)).toEqual([DAG, CY, BO, ANNA]);
    expect(result.candidates.map((c) => c.qualificationKind)).toEqual(['LEGITIMATION', 'BEHORIG', 'TILLATEN', null]);
    expect(result.qualificationsRecorded).toBe(true);
  });

  it('judges the behörighet against the group’s span and the year, as the report does', () => {
    const result = suggestTeachers(
      input({
        qualifications: [
          qual(ANNA, { minGradeLevel: 1, maxGradeLevel: 6 }),
          qual(BO, { validTo: '2026-06-30' }),
          qual(CY, { kind: 'TILLATEN', validFrom: '2027-01-01' }),
        ],
      }),
      'target',
      [ANNA, BO, CY],
    );
    expect(result.candidates.find((c) => c.userId === ANNA)!.qualificationKind).toBeNull();
    expect(result.candidates.find((c) => c.userId === BO)!.qualificationKind).toBeNull();
    // Valid from January: valid at some point of the year, so it counts.
    expect(result.candidates[0]).toMatchObject({ userId: CY, qualificationKind: 'TILLATEN' });
  });

  it('puts the group’s own teachers next, then the most room left', () => {
    const result = suggestTeachers(
      input({
        requirements: [
          row('target'),
          row('bo-8a', { subjectId: 'sv', subjectName: 'Svenska', teacherId: BO, lessonsPerWeek: 10 }),
          // NO, not Ma: with no behörighet recorded, teaching the subject is tier (1).
          row('cy-elsewhere', { subjectId: 'no', subjectName: 'NO', studentGroupId: 'g-9b', groupName: '9B', teacherId: CY, lessonsPerWeek: 2 }),
        ],
      }),
      'target',
      [ANNA, BO, CY],
    );
    // Bo teaches 8A (Sv) though he has least room; then Anna 1080 − 240 = 840
    // before Cy 1080 − 120 − 240 = 720.
    expect(order(result)).toEqual([BO, ANNA, CY]);
    expect(result.candidates.map((c) => c.remainingMinutesPerWeek)).toEqual([240, 840, 720]);
    expect(result.candidates[0]).toMatchObject({ teachesGroupAlready: true, teachesSubjectAlready: false });
  });

  it('charges the row at the lead’s percentage and counts uppdrag that count', () => {
    const result = suggestTeachers(
      input({
        requirements: [row('target', { teacherLoadPercent: 50, recurrence: 'ODD_WEEKS' })],
        duties: [
          { userId: ANNA, minutesPerWeek: 100, countsAsTeaching: true },
          { userId: ANNA, minutesPerWeek: 500, countsAsTeaching: false },
        ],
      }),
      'target',
      [ANNA],
    );
    // 240 × ½ × 50 % = 60; Anna 1080 − 100 − 60.
    expect(result.teacherMinutesPerWeek).toBe(60);
    expect(result.candidates[0]!.remainingMinutesPerWeek).toBe(920);
  });

  it('says wouldExceed exactly past the tolerance, and sorts NO_TARGET last in its tier', () => {
    const result = suggestTeachers(
      input({
        employments: [
          post(ANNA, { teachingTargetMinutesPerWeek: 200 }), // 240 vs 220: over
          post(BO, { teachingTargetMinutesPerWeek: 220 }), // 240 vs 242: on the edge, OK
        ],
      }),
      'target',
      [ANNA, BO, CY],
    );
    expect(result.candidates).toEqual([
      expect.objectContaining({ userId: BO, remainingMinutesPerWeek: -20, wouldExceed: false, status: 'OK' }),
      expect.objectContaining({ userId: ANNA, remainingMinutesPerWeek: -40, wouldExceed: true, status: 'OVER' }),
      expect.objectContaining({ userId: CY, remainingMinutesPerWeek: null, wouldExceed: false, status: 'NO_TARGET' }),
    ]);
  });

  it('never says wouldExceed for a row that charges nothing, which the write lets through', () => {
    // A resurslärare row at 0 %: Anna is already over (240 of 200), but taking
    // this row adds nothing, and the over-target check asks only of a write
    // that adds minutes. Her status stays what it is.
    const result = suggestTeachers(
      input({
        employments: [post(ANNA, { teachingTargetMinutesPerWeek: 200 })],
        requirements: [
          row('target', { teacherLoadPercent: 0 }),
          row('held', { teacherId: ANNA, studentGroupId: 'g-9a', groupName: '9A' }),
        ],
      }),
      'target',
      [ANNA],
    );
    expect(result.candidates[0]).toMatchObject({ userId: ANNA, wouldExceed: false, status: 'OVER' });
  });

  it('compares the current lead on the same footing, and leaves the co-teacher out', () => {
    const result = suggestTeachers(
      input({ requirements: [row('target', { teacherId: ANNA, coTeacherId: BO })] }),
      'target',
      [ANNA, BO, CY],
    );
    expect(order(result)).toEqual([ANNA, CY]);
    expect(result.candidates[0]).toMatchObject({ currentlyAssigned: true, remainingMinutesPerWeek: 840 });
    expect(result.candidates[1]).toMatchObject({ currentlyAssigned: false, remainingMinutesPerWeek: 840 });
  });

  it('falls back to "teaches the subject" when the school has recorded no behörighet', () => {
    const result = suggestTeachers(
      input({
        requirements: [
          row('target'),
          row('cy-ma', { studentGroupId: 'g-9b', groupName: '9B', teacherId: CY, lessonsPerWeek: 10 }),
          row('anna-co', { studentGroupId: 'g-7c', groupName: '7C', coTeacherId: ANNA, lessonsPerWeek: 1 }),
        ],
      }),
      'target',
      [ANNA, BO, CY],
    );
    expect(result.qualificationsRecorded).toBe(false);
    // Anna co-teaches Ma elsewhere; Cy leads it; Bo does not teach it at all.
    expect(order(result)).toEqual([ANNA, CY, BO]);
    expect(result.candidates.every((c) => c.qualificationKind === null)).toBe(true);
  });

  it('lists each person once whatever the caller hands in', () => {
    expect(order(suggestTeachers(input(), 'target', [ANNA, ANNA]))).toEqual([ANNA]);
  });

  describe('continuity: the same teacher as last year', () => {
    const LAST = (teacherIds: string[]) => ({ groupName: '7A', yearName: '2025/26', teacherIds });

    it('ranks last year’s teacher after behörighet and before the group’s own teachers', () => {
      const result = suggestTeachers(
        input({
          employments: [post(ANNA), post(BO), post(CY), post(DAG)],
          requirements: [
            row('target'),
            // Bo already teaches 8A (Sv); Cy taught 7A Ma last year.
            row('bo-8a', { subjectId: 'sv', subjectName: 'Svenska', teacherId: BO, lessonsPerWeek: 1 }),
          ],
          qualifications: [qual(BO), qual(CY), qual(DAG, { kind: 'BEHORIG' })],
        }),
        'target',
        [ANNA, BO, CY, DAG],
        LAST([CY, DAG]),
      );
      // Tier LEGITIMATION: Cy (last year) before Bo (the group); then Dag,
      // BEHORIG, though he taught it last year; then Anna.
      expect(order(result)).toEqual([CY, BO, DAG, ANNA]);
      expect(result.candidates.map((c) => c.taughtLastYear)).toEqual([true, false, true, false]);
      expect(result.lastYear).toEqual({ groupName: '7A', yearName: '2025/26' });
    });

    it('never lifts a candidate over a better-qualified one', () => {
      const result = suggestTeachers(
        input({ qualifications: [qual(ANNA, { kind: 'TILLATEN' })] }),
        'target',
        [ANNA, BO],
        LAST([BO]),
      );
      expect(order(result)).toEqual([ANNA, BO]);
      expect(result.candidates[1]).toMatchObject({ userId: BO, taughtLastYear: true, qualificationKind: null });
    });

    it('joins the fallback tier when the school has recorded no behörighet', () => {
      // A freshly rolled year: Cy was staffed first in Ma (9B), Bo taught
      // 7A Ma last year and has nothing yet. Without continuity in the tier
      // Bo would sit below Cy and level with Anna.
      const result = suggestTeachers(
        input({
          requirements: [
            row('target'),
            row('cy-ma', { studentGroupId: 'g-9b', groupName: '9B', teacherId: CY, lessonsPerWeek: 1 }),
          ],
        }),
        'target',
        [ANNA, BO, CY],
        LAST([BO]),
      );
      expect(order(result)).toEqual([BO, CY, ANNA]);
    });

    it('flags lead and co-teacher alike, and nobody when last year’s row had none', () => {
      const both = suggestTeachers(input(), 'target', [ANNA, BO, CY], LAST([ANNA, BO]));
      expect(both.candidates.filter((c) => c.taughtLastYear).map((c) => c.userId)).toEqual([ANNA, BO]);

      const none = suggestTeachers(input(), 'target', [ANNA, BO, CY], LAST([]));
      expect(none.candidates.some((c) => c.taughtLastYear)).toBe(false);
      expect(none.lastYear).toEqual({ groupName: '7A', yearName: '2025/26' });
    });

    it('is today’s ranking exactly without a predecessor', () => {
      const rows = input({
        employments: [post(ANNA), post(BO), post(CY), post(DAG)],
        requirements: [
          row('target'),
          row('bo-8a', { subjectId: 'sv', subjectName: 'Svenska', teacherId: BO, lessonsPerWeek: 10 }),
        ],
        qualifications: [qual(BO, { kind: 'TILLATEN' }), qual(CY, { kind: 'BEHORIG' }), qual(DAG)],
      });
      const without = suggestTeachers(rows, 'target', [ANNA, BO, CY, DAG]);
      const withNull = suggestTeachers(rows, 'target', [ANNA, BO, CY, DAG], null);
      expect(withNull).toEqual(without);
      expect(without.lastYear).toBeNull();
      expect(without.candidates.every((c) => c.taughtLastYear === false)).toBe(true);
      expect(order(without)).toEqual([DAG, CY, BO, ANNA]);
    });
  });
});
