import {
  fromNioarig,
  gradeOfPlanRow,
  lydelseIsTioarig,
  planRowOf,
  toNioarig,
  toNioarigSpan,
  unitGradeOf,
  unitSpanIn,
} from './grade-numbering';

/**
 * What the numbering MEANS, case by case; the contract spec only replays the
 * generated answers, and a generator can be wrong.
 */
describe('one årskull, two numbers (SFS 2025:729 övergångsbestämmelse 4)', () => {
  it('reads a TIOARIG årskurs one lower in NIOARIG: åk 1 is the old förskoleklass, åk 10 the old nian', () => {
    expect([1, 2, 8, 10, 11].map((grade) => toNioarig(grade, 'TIOARIG'))).toEqual([0, 1, 7, 9, 10]);
    expect([0, 7, 9].map((grade) => toNioarig(grade, 'NIOARIG'))).toEqual([0, 7, 9]);
  });

  it('reads a NIOARIG årskurs one higher in TIOARIG, and back', () => {
    expect([0, 3, 9, 10].map((grade) => fromNioarig(grade, 'TIOARIG'))).toEqual([1, 4, 10, 11]);
    for (let grade = 1; grade <= 11; grade++) {
      expect(fromNioarig(toNioarig(grade, 'TIOARIG'), 'TIOARIG')).toBe(grade);
    }
  });

  it('keeps 12 as "and above" in both, so a whole-school span 0–12 stays inside the bounds', () => {
    expect(toNioarig(12, 'TIOARIG')).toBe(12);
    expect(fromNioarig(12, 'TIOARIG')).toBe(12);
    // NIOARIG 11 is no form's årskurs; read as "above", never as 12+.
    expect(fromNioarig(11, 'TIOARIG')).toBe(12);
  });

  it('has no TIOARIG 0, and knows no årskurs for none', () => {
    expect(toNioarig(0, 'TIOARIG')).toBe(0);
    expect(toNioarig(null, 'TIOARIG')).toBeNull();
    expect(fromNioarig(null, 'NIOARIG')).toBeNull();
  });
});

describe('the row of a lokal timplan an årskurs reads', () => {
  it('reads a plan in its own numbering row for row', () => {
    expect(planRowOf(false, 'NIOARIG', 7)).toBe(7);
    expect(planRowOf(true, 'TIOARIG', 7)).toBe(7);
  });

  it('reads an older plan one row down in a TIOARIG läsår: 10A its row 9, 1A its förskoleklass row', () => {
    expect(planRowOf(false, 'TIOARIG', 10)).toBe(9);
    expect(planRowOf(false, 'TIOARIG', 1)).toBe(0);
    expect(planRowOf(false, 'TIOARIG', 0)).toBeNull();
  });

  it('reads a 2028 plan one row up in a NIOARIG läsår, and inverts', () => {
    expect(planRowOf(true, 'NIOARIG', 9)).toBe(10);
    expect(gradeOfPlanRow(false, 'TIOARIG', 9)).toBe(10);
    expect(gradeOfPlanRow(true, 'NIOARIG', 1)).toBe(0);
    expect(gradeOfPlanRow(true, 'NIOARIG', 0)).toBeNull();
  });

  it('knows a lydelse from HT 2028 numbers its årskurser TIOARIG', () => {
    expect(['HT2024', 'HT2028', 'HT2031', 'VT2028', 'x'].map(lydelseIsTioarig)).toEqual([false, true, true, true, false]);
  });
});

describe('a school-wide span against a TIOARIG läsår', () => {
  it('reads the läsår\'s årskurser in NIOARIG, where a frame or a behörighet is stated: 8–10 is 7–9', () => {
    expect(toNioarigSpan({ min: 8, max: 10 }, 'TIOARIG')).toEqual({ min: 7, max: 9 });
    expect(toNioarigSpan({ min: 1, max: 4 }, 'TIOARIG')).toEqual({ min: 0, max: 3 });
    expect(toNioarigSpan({ min: 7, max: 9 }, 'NIOARIG')).toEqual({ min: 7, max: 9 });
    expect(toNioarigSpan(null, 'TIOARIG')).toBeNull();
  });
});

describe('a skolenhet in a TIOARIG läsår (SFS 2025:729 övergångsbestämmelse 5)', () => {
  it('reads an approval one årskurs up, and one from åk 1 also for the new åk 1', () => {
    expect(unitSpanIn({ gradeFrom: 7, gradeTo: 9 }, 'TIOARIG')).toEqual({ gradeFrom: 8, gradeTo: 10 });
    expect(unitSpanIn({ gradeFrom: 0, gradeTo: 6 }, 'TIOARIG')).toEqual({ gradeFrom: 1, gradeTo: 7 });
    expect(unitSpanIn({ gradeFrom: 1, gradeTo: 6 }, 'TIOARIG')).toEqual({ gradeFrom: 1, gradeTo: 7 });
    expect(unitSpanIn({ gradeFrom: 0, gradeTo: 10 }, 'TIOARIG')).toEqual({ gradeFrom: 1, gradeTo: 11 });
  });

  it('lets a förskoleklass-only approval lapse, keeps a nine-year läsår as stated, and knows no span for none', () => {
    expect(unitSpanIn({ gradeFrom: 0, gradeTo: 0 }, 'TIOARIG')).toBeNull();
    expect(unitSpanIn({ gradeFrom: 0, gradeTo: 6 }, 'NIOARIG')).toEqual({ gradeFrom: 0, gradeTo: 6 });
    expect(unitSpanIn({ gradeFrom: null, gradeTo: null }, 'TIOARIG')).toBeNull();
  });

  it('reads a class back to the årskurs a unit must hold: the new åk 1 as 1, the rest one down', () => {
    expect([1, 2, 7, 8, 10, 11, 12].map((grade) => unitGradeOf(grade, 'TIOARIG'))).toEqual([1, 1, 6, 7, 9, 10, 12]);
    expect([0, 1, 9, 10].map((grade) => unitGradeOf(grade, 'NIOARIG'))).toEqual([0, 1, 9, 10]);
    expect(unitGradeOf(null, 'TIOARIG')).toBeNull();
  });

  it('is unitSpanIn the other way: a unit holds a tioårig class exactly when its span holds unitGradeOf', () => {
    for (let from = 0; from <= 10; from++) {
      for (let to = from; to <= 10; to++) {
        const read = unitSpanIn({ gradeFrom: from, gradeTo: to }, 'TIOARIG');
        for (let grade = 1; grade <= 12; grade++) {
          const held = read !== null && read.gradeFrom <= grade && grade <= read.gradeTo;
          const back = unitGradeOf(grade, 'TIOARIG')!;
          expect([from, to, grade, from <= back && back <= to]).toEqual([from, to, grade, held]);
        }
      }
    }
  });
});
