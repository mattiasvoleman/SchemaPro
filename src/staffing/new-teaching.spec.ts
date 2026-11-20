import { gradesOf, newTeachingOf, teachersOfRow, teachingToday } from './new-teaching';

const ANNA = 'd0000000-0000-4000-8000-00000000000a';
const BO = 'd0000000-0000-4000-8000-00000000000b';
const CY = 'd0000000-0000-4000-8000-00000000000c';
const MA = 'e0000000-0000-4000-8000-0000000000aa';
const SV = 'e0000000-0000-4000-8000-0000000000bb';
const NO = 'e0000000-0000-4000-8000-0000000000cc';

const row = (over: Record<string, unknown> = {}) => ({
  subjectId: MA,
  teacherId: null as string | null,
  coTeacherId: null as string | null,
  shares: [] as { teacherId: string | null; lessons: number; minutes: number }[],
  gradeSpan: { min: 7, max: 7 } as { min: number; max: number } | null,
  ...over,
});

describe('ny undervisning (new-teaching.ts)', () => {
  describe('gradesOf', () => {
    it('lists every grade of a span, and none for no span', () => {
      expect(gradesOf({ min: 7, max: 9 })).toEqual([7, 8, 9]);
      expect(gradesOf({ min: 8, max: 8 })).toEqual([8]);
      expect(gradesOf(null)).toEqual([]);
    });
  });

  describe('teachersOfRow', () => {
    it('is the lead, the co-teacher and each teacher of a share, once each, and nobody for a removed teacher', () => {
      expect(
        teachersOfRow(row({ teacherId: ANNA, coTeacherId: BO, shares: [{ teacherId: CY, lessons: 1, minutes: 60 }, { teacherId: ANNA, lessons: 1, minutes: 60 }, { teacherId: null, lessons: 1, minutes: 60 }] })),
      ).toEqual([ANNA, BO, CY]);
      expect(teachersOfRow(row())).toEqual([]);
    });
  });

  describe('what a teacher teaches today', () => {
    const today = teachingToday([
      row({ subjectId: MA, teacherId: ANNA, gradeSpan: { min: 7, max: 7 } }),
      row({ subjectId: SV, coTeacherId: ANNA, gradeSpan: { min: 8, max: 8 } }),
      row({ subjectId: NO, teacherId: BO, shares: [{ teacherId: CY, lessons: 1, minutes: 60 }], gradeSpan: { min: 9, max: 9 } }),
      row({ subjectId: MA, teacherId: BO, gradeSpan: null }),
    ]);

    it('counts the lead, the co-teacher and a share alike', () => {
      expect([...(today.subjects.get(ANNA) ?? [])].sort()).toEqual([MA, SV].sort());
      expect([...(today.years.get(ANNA) ?? [])].sort()).toEqual([7, 8]);
      expect([...(today.subjects.get(CY) ?? [])]).toEqual([NO]);
      expect([...(today.years.get(CY) ?? [])]).toEqual([9]);
    });

    it('takes no year from a group that has none, and still the subject', () => {
      expect([...(today.subjects.get(BO) ?? [])].sort()).toEqual([MA, NO].sort());
      expect([...(today.years.get(BO) ?? [])]).toEqual([9]);
    });
  });

  describe('newTeachingOf', () => {
    const today = teachingToday([
      row({ subjectId: MA, teacherId: ANNA, gradeSpan: { min: 7, max: 8 } }),
      row({ subjectId: NO, shares: [{ teacherId: BO, lessons: 1, minutes: 60 }], teacherId: CY, gradeSpan: { min: 9, max: 9 } }),
    ]);

    it('is null when the teacher teaches the subject and the year already', () => {
      expect(newTeachingOf(today, row({ subjectId: MA, gradeSpan: { min: 8, max: 8 } }), ANNA)).toBeNull();
    });

    it('names a new subject on its own', () => {
      expect(newTeachingOf(today, row({ subjectId: SV, gradeSpan: { min: 7, max: 7 } }), ANNA)).toEqual({ subject: true, years: [] });
    });

    it('names a new year on its own, every year of a span the teacher does not teach', () => {
      expect(newTeachingOf(today, row({ subjectId: MA, gradeSpan: { min: 9, max: 9 } }), ANNA)).toEqual({ subject: false, years: [9] });
      expect(newTeachingOf(today, row({ subjectId: MA, gradeSpan: { min: 8, max: 10 } }), ANNA)).toEqual({ subject: false, years: [9, 10] });
    });

    it('names both, and everything to a teacher who teaches nothing today', () => {
      expect(newTeachingOf(today, row({ subjectId: SV, gradeSpan: { min: 9, max: 9 } }), ANNA)).toEqual({ subject: true, years: [9] });
      expect(newTeachingOf(today, row({ subjectId: MA, gradeSpan: { min: 7, max: 7 } }), '00000000-0000-4000-8000-0000000000ee')).toEqual({ subject: true, years: [7] });
    });

    it('does not count a teacher of a share as new to the subject and the year: they teach it', () => {
      expect(newTeachingOf(today, row({ subjectId: NO, gradeSpan: { min: 9, max: 9 } }), BO)).toBeNull();
    });

    it('says nothing of years for a group with no year, and can still give a new subject', () => {
      expect(newTeachingOf(today, row({ subjectId: MA, gradeSpan: null }), ANNA)).toBeNull();
      expect(newTeachingOf(today, row({ subjectId: SV, gradeSpan: null }), ANNA)).toEqual({ subject: true, years: [] });
    });

    it('is judged against today, not against the other changes of the same proposal', () => {
      // Two rows of Svenska to a teacher who teaches none: each is a new subject, whichever is applied.
      const first = newTeachingOf(today, row({ subjectId: SV, gradeSpan: { min: 7, max: 7 } }), BO);
      const second = newTeachingOf(today, row({ subjectId: SV, gradeSpan: { min: 7, max: 7 } }), BO);
      expect(first).toEqual({ subject: true, years: [7] });
      expect(second).toEqual(first);
    });
  });
});
