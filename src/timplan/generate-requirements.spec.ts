import { BadRequestException } from '@nestjs/common';
import { proposeRequirements, type GenerateInput } from './generate-requirements';

const MA = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const SV = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const EN = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
const BL = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const A7 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const B7 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const A9 = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';

const input = (over: Partial<GenerateInput> = {}): GenerateInput => ({
  gradeLevels: [7],
  entries: [
    { subjectId: MA, gradeLevel: 7, minutesPerWeek: 180 },
    { subjectId: SV, gradeLevel: 7, minutesPerWeek: 175 },
    { subjectId: EN, gradeLevel: 7, minutesPerWeek: 140 },
    { subjectId: BL, gradeLevel: 7, minutesPerWeek: 0 },
    { subjectId: MA, gradeLevel: 9, minutesPerWeek: 50 },
  ],
  classes: [
    { id: B7, name: '7B', gradeLevel: 7 },
    { id: A7, name: '7A', gradeLevel: 7 },
    { id: A9, name: '9A', gradeLevel: 9 },
  ],
  subjectNames: new Map([
    [MA, 'Matematik'],
    [SV, 'Svenska'],
    [EN, 'Engelska'],
    [BL, 'Bild'],
  ]),
  nationalCodes: new Map([
    [MA, 'MA'],
    [SV, 'SV_SVA'],
    [EN, 'EN'],
    [BL, 'BL'],
  ]),
  existing: [],
  minutesPerLesson: 60,
  overrides: [],
  ...over,
});

describe('proposeRequirements', () => {
  it('rounds every target UP to whole lessons and states the surplus: 180 → 3 × 60, 175 → 3 × 60 +5, 140 → 3 × 60 +40', () => {
    const { rows, skipped } = proposeRequirements(input());
    expect(skipped).toEqual([]);
    expect(rows.filter((row) => row.studentGroupId === A7).map((row) => [row.subjectName, row.lessonsPerWeek, row.minutesPerLesson, row.surplusMinutesPerWeek])).toEqual([
      ['Engelska', 3, 60, 40],
      ['Matematik', 3, 60, 0],
      ['Svenska', 3, 60, 5],
    ]);
    // Classes in name order; the 0-minute Bild entry and åk 9 (not attached to this plan) produce nothing.
    expect([...new Set(rows.map((row) => row.groupName))]).toEqual(['7A', '7B']);
    expect(rows.some((row) => row.subjectId === BL)).toBe(false);
  });

  it('140 at 70 is 2 × 70 with nothing over, and 50 at 50 is one lesson', () => {
    expect(proposeRequirements(input({ minutesPerLesson: 70 })).rows.find((r) => r.subjectId === EN && r.studentGroupId === A7)).toMatchObject({
      lessonsPerWeek: 2,
      surplusMinutesPerWeek: 0,
    });
    const nine = proposeRequirements(input({ gradeLevels: [9], minutesPerLesson: 50 }));
    expect(nine.rows).toEqual([expect.objectContaining({ groupName: '9A', lessonsPerWeek: 1, minutesPerLesson: 50, plannedMinutesPerWeek: 50 })]);
  });

  it('skips a (class, subject) the year already has, naming it, and never proposes to change it', () => {
    const { rows, skipped } = proposeRequirements(input({ existing: [{ studentGroupId: A7, subjectId: MA }] }));
    expect(skipped).toEqual([
      { studentGroupId: A7, groupName: '7A', subjectId: MA, subjectName: 'Matematik', gradeLevel: 7, reason: 'EXISTS', alternativeCode: null, alternativeTo: null },
    ]);
    expect(rows.some((row) => row.studentGroupId === A7 && row.subjectId === MA)).toBe(false);
  });

  it('caps a row at 40 lessons and says so, rather than writing a row the engine refuses', () => {
    const { rows } = proposeRequirements(
      input({ entries: [{ subjectId: MA, gradeLevel: 7, minutesPerWeek: 1200 }], minutesPerLesson: 15, classes: [{ id: A7, name: '7A', gradeLevel: 7 }] }),
    );
    expect(rows[0]).toMatchObject({ lessonsPerWeek: 40, plannedMinutesPerWeek: 600, surplusMinutesPerWeek: -600, capped: true });
  });

  it('takes the preview’s edited rows as they were edited, and leaves an override of a skipped row skipped', () => {
    const { rows, skipped } = proposeRequirements(
      input({
        existing: [{ studentGroupId: B7, subjectId: SV }],
        overrides: [
          { studentGroupId: A7, subjectId: SV, lessonsPerWeek: 4, minutesPerLesson: 45 },
          { studentGroupId: B7, subjectId: SV, lessonsPerWeek: 2, minutesPerLesson: 90 },
        ],
      }),
    );
    expect(rows.find((row) => row.studentGroupId === A7 && row.subjectId === SV)).toMatchObject({
      lessonsPerWeek: 4,
      minutesPerLesson: 45,
      surplusMinutesPerWeek: 5,
      overridden: true,
      capped: false,
    });
    expect(skipped.map((row) => [row.groupName, row.subjectName])).toEqual([['7B', 'Svenska']]);
  });

  it('400s an override for a pair the plan gives no row, and the same pair twice', () => {
    expect(() =>
      proposeRequirements(input({ overrides: [{ studentGroupId: A9, subjectId: MA, lessonsPerWeek: 1, minutesPerLesson: 60 }] })),
    ).toThrow(BadRequestException);
    expect(() =>
      proposeRequirements(
        input({
          overrides: [
            { studentGroupId: A7, subjectId: MA, lessonsPerWeek: 1, minutesPerLesson: 60 },
            { studentGroupId: A7, subjectId: MA, lessonsPerWeek: 2, minutesPerLesson: 60 },
          ],
        }),
      ),
    ).toThrow('overrides: rad 2 gäller samma klass och ämne');
  });

  it('proposes nothing for a year that attaches no årskurs to the plan', () => {
    expect(proposeRequirements(input({ gradeLevels: [] }))).toEqual({ rows: [], skipped: [] });
  });

  describe('alternatives (SV_SVA, M2)', () => {
    // Review reproduction (P2 review, all three lenses): every alternative
    // subject became a class post — Svenska AND SvA, Spanska AND Tyska AND
    // Franska on 7A — 900 min/week for a pupil's 480, which the coverage
    // then read as OVER twice.
    const SVA = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5';
    const ES = 'd6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6';
    const DE = 'd7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7';
    const alternatives = (over: Partial<GenerateInput> = {}): GenerateInput =>
      input({
        classes: [{ id: A7, name: '7A', gradeLevel: 7 }],
        entries: [
          { subjectId: MA, gradeLevel: 7, minutesPerWeek: 180 },
          { subjectId: SV, gradeLevel: 7, minutesPerWeek: 180 },
          { subjectId: SVA, gradeLevel: 7, minutesPerWeek: 180 },
          { subjectId: ES, gradeLevel: 7, minutesPerWeek: 120 },
          { subjectId: DE, gradeLevel: 7, minutesPerWeek: 120 },
        ],
        subjectNames: new Map([
          [MA, 'Matematik'],
          [SV, 'Svenska'],
          [SVA, 'Svenska som andraspråk'],
          [ES, 'Spanska'],
          [DE, 'Tyska'],
        ]),
        nationalCodes: new Map([
          [MA, 'MA'],
          [SV, 'SV_SVA'],
          [SVA, 'SV_SVA'],
          [ES, 'M2'],
          [DE, 'M2'],
        ]),
        ...over,
      });

    it('gives the class one subject of SV_SVA and no språkval, and names the rest as alternatives', () => {
      const { rows, skipped } = proposeRequirements(alternatives());
      expect(rows.map((row) => [row.subjectName, row.lessonsPerWeek])).toEqual([
        ['Matematik', 3],
        ['Svenska', 3],
      ]);
      expect(skipped.map((row) => [row.subjectName, row.reason, row.alternativeCode, row.alternativeTo])).toEqual([
        ['Spanska', 'ALTERNATIVE', 'M2', null],
        ['Svenska som andraspråk', 'ALTERNATIVE', 'SV_SVA', 'Svenska'],
        ['Tyska', 'ALTERNATIVE', 'M2', null],
      ]);
    });

    it('takes the SV_SVA subject with the highest target when the plan gives them different minutes', () => {
      const { rows } = proposeRequirements(
        alternatives({
          entries: [
            { subjectId: SV, gradeLevel: 7, minutesPerWeek: 160 },
            { subjectId: SVA, gradeLevel: 7, minutesPerWeek: 200 },
          ],
        }),
      );
      expect(rows.map((row) => [row.subjectName, row.targetMinutesPerWeek])).toEqual([
        ['Svenska som andraspråk', 200],
      ]);
    });

    it('proposes nothing in SV_SVA when the class already has either subject', () => {
      const { rows, skipped } = proposeRequirements(
        alternatives({ existing: [{ studentGroupId: A7, subjectId: SVA }] }),
      );
      expect(rows.map((row) => row.subjectName)).toEqual(['Matematik']);
      expect(skipped.filter((row) => row.alternativeCode === 'SV_SVA').map((row) => [row.subjectName, row.reason, row.alternativeTo])).toEqual([
        ['Svenska', 'ALTERNATIVE', 'Svenska som andraspråk'],
        ['Svenska som andraspråk', 'EXISTS', null],
      ]);
    });
  });
});
