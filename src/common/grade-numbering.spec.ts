import {
  fromNioarig,
  gradeOfPlanRow,
  lydelseIsTioarig,
  planRowOf,
  toNioarig,
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
