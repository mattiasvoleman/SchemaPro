import { BadRequestException } from '@nestjs/common';
import { proposeRequirements, splitWeeklyMinutes, type GenerateInput } from './generate-requirements';
import { lengthsProblem } from '../common/lesson-lengths';

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

describe('splitWeeklyMinutes', () => {
  it.each<[number, number, number[], number[], number[], number[]]>([
    // [T, (unused), SPLIT at 60, ROUND_UP at 60, SPLIT at 40, ROUND_UP at 40] — the spec's table.
    [175, 0, [60, 60, 55], [60, 60, 60], [55, 40, 40, 40], [40, 40, 40, 40, 40]],
    [180, 0, [60, 60, 60], [60, 60, 60], [60, 40, 40, 40], [40, 40, 40, 40, 40]],
    [200, 0, [80, 60, 60], [60, 60, 60, 60], [40, 40, 40, 40, 40], [40, 40, 40, 40, 40]],
    [45, 0, [45], [60], [45], [40, 40]],
    [250, 0, [70, 60, 60, 60], [60, 60, 60, 60, 60], [50, 40, 40, 40, 40, 40], [40, 40, 40, 40, 40, 40, 40]],
  ])('%s min/vecka', (minutes, _unused, split60, round60, split40, round40) => {
    expect(splitWeeklyMinutes(minutes, 60, 'SPLIT').lengths).toEqual(split60);
    expect(splitWeeklyMinutes(minutes, 60, 'ROUND_UP').lengths).toEqual(round60);
    expect(splitWeeklyMinutes(minutes, 40, 'SPLIT').lengths).toEqual(split40);
    expect(splitWeeklyMinutes(minutes, 40, 'ROUND_UP').lengths).toEqual(round40);
  });

  it.each<[string, number, number, number[], boolean]>([
    ['173 rounds to the grid first: 2 × 60 + 1 × 55, +2', 173, 60, [60, 60, 55], false],
    ['178 rounds to 180: 3 × 60, +2', 178, 60, [60, 60, 60], false],
    ['a fold that stays in bounds: 410 at 200 is 210 + 200', 410, 200, [210, 200], false],
    ['a fold past 240 with a remainder of 20 keeps it as a lesson: 480 at 230', 480, 230, [230, 230, 20], false],
    ['a fold past 240 with a remainder under 15 rounds it to 15: 241 at 235', 241, 235, [235, 15], false],
    ['under one lesson of 15 is one lesson of 15', 10, 15, [15], false],
    ['20 at 15 folds the 5 into one lesson of 20', 20, 15, [20], false],
    ['40 at 15 is 25 + 15', 40, 15, [25, 15], false],
    ['the roadmap’s idrott: 120 at 80 is 1 × 80 + 1 × 40, twice a week, not one lesson of 120', 120, 80, [80, 40], false],
    ['beside one lesson the remainder stays its own: 90 at 60 is 1 × 60 + 1 × 30', 90, 60, [60, 30], false],
    ['beside one lesson even at L/2 exactly: 100 at 80 is 1 × 80 + 1 × 20', 100, 80, [80, 20], false],
    ['beside one lesson, under 15 still folds: 65 at 60 is 1 × 65', 65, 60, [65], false],
    ['beside two lessons the fold stands: 200 at 80 is 1 × 120 + 1 × 80', 200, 80, [120, 80], false],
    ['41 lessons are capped, not folded into one of 50: 1220 at 30', 1220, 30, Array(40).fill(30), true],
    ['41 lessons are capped, not folded into one of 95: 2045 at 50', 2045, 50, Array(40).fill(50), true],
    ['past 40 with nothing to fold, capped as ROUND_UP caps', 1200, 15, Array(40).fill(15), true],
  ])('%s', (_case, minutes, length, lengths, capped) => {
    expect(splitWeeklyMinutes(minutes, length, 'SPLIT')).toEqual({ lengths, capped });
  });

  it('never writes a length the engine refuses, never three kinds, never short, and over only where it must', () => {
    let checked = 0;
    for (let length = 15; length <= 240; length += 5) {
      for (let minutes = 1; minutes <= 2400; minutes += 1) {
        const { lengths, capped } = splitWeeklyMinutes(minutes, length, 'SPLIT');
        const sum = lengths.reduce((a, b) => a + b, 0);
        const where = `${minutes} at ${length}: ${lengths.join('+')}`;
        expect([where, lengthsProblem(lengths)]).toEqual([where, null]);
        expect([where, new Set(lengths).size <= 2]).toEqual([where, true]);
        expect([where, lengths.length <= 40]).toEqual([where, true]);
        // No lesson longer than L + L/2 (a fold of r ≤ L/2), or L + 14 (a fold of
        // a remnant under 15), or 15 — the documented rule, at the cap too.
        expect([where, Math.max(...lengths) <= Math.max(length + Math.max(length / 2, 14), 15)]).toEqual([where, true]);
        // Beside a single lesson a remainder of 15 or more is its own lesson.
        const onGrid = Math.ceil(minutes / 5) * 5;
        if (Math.floor(onGrid / length) === 1 && onGrid - length >= 15) {
          expect([where, lengths.length]).toEqual([where, 2]);
        }
        if (capped) continue;
        expect([where, sum >= minutes]).toEqual([where, true]);
        // The surplus: the grid's 0..4, or up to 14 where a remainder under 15
        // could not be folded past 240, or a target under one 15-minute lesson.
        const target = Math.ceil(minutes / 5) * 5;
        const r = target - Math.floor(target / length) * length;
        const unfoldable = length + r > 240 && r > 0 && r < 15;
        const allowed = minutes < 15 ? 15 - minutes : unfoldable ? 14 : 4;
        expect([where, sum - minutes <= allowed]).toEqual([where, true]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(100_000);
  });

  it('leaves ROUND_UP the rule it was', () => {
    expect(splitWeeklyMinutes(175, 60, 'ROUND_UP')).toEqual({ lengths: [60, 60, 60], capped: false });
    expect(splitWeeklyMinutes(1200, 15, 'ROUND_UP')).toEqual({ lengths: Array(40).fill(15), capped: true });
  });
});

describe('proposeRequirements with SPLIT', () => {
  it('meets 175 as 2 × 60 + 1 × 55 and names the lengths, and leaves a whole row uniform', () => {
    const { rows } = proposeRequirements(input({ remainder: 'SPLIT' }));
    const a7 = rows.filter((row) => row.studentGroupId === A7);
    expect(a7.map((row) => [row.subjectName, row.lessonsPerWeek, row.minutesPerLesson, row.lessonLengths, row.plannedMinutesPerWeek, row.surplusMinutesPerWeek])).toEqual([
      // 140 at 60: q = 2, r = 20 ≤ 30, folded.
      ['Engelska', 2, 80, [80, 60], 140, 0],
      ['Matematik', 3, 60, undefined, 180, 0],
      ['Svenska', 3, 60, [60, 60, 55], 175, 0],
    ]);
    // A uniform row carries no list key at all.
    expect(a7.find((row) => row.subjectName === 'Matematik')).not.toHaveProperty('lessonLengths');
  });

  it('keeps an override uniform, as the admin typed it', () => {
    const { rows } = proposeRequirements(
      input({ remainder: 'SPLIT', overrides: [{ studentGroupId: A7, subjectId: SV, lessonsPerWeek: 3, minutesPerLesson: 60 }] }),
    );
    const sv = rows.find((row) => row.studentGroupId === A7 && row.subjectId === SV)!;
    expect(sv).toMatchObject({ lessonsPerWeek: 3, minutesPerLesson: 60, surplusMinutesPerWeek: 5, overridden: true });
    expect(sv).not.toHaveProperty('lessonLengths');
  });

  it('answers byte for byte as before when the mode is not stated', () => {
    expect(JSON.stringify(proposeRequirements(input()))).toEqual(
      JSON.stringify(proposeRequirements(input({ remainder: 'ROUND_UP' }))),
    );
    expect(JSON.stringify(proposeRequirements(input()))).not.toContain('lessonLengths');
  });
});
