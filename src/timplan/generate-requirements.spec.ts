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

describe('proposeRequirements in the tioårig numbering (SFS 2025:729)', () => {
  it('gives a class of a TIOARIG year the older plan’s row of its own årskull: 8A reads row 7', () => {
    const { rows } = proposeRequirements(
      input({
        gradeLevels: [8],
        classes: [{ id: A7, name: '8A', gradeLevel: 8 }],
        planTioarig: false,
        gradeNumbering: 'TIOARIG',
      }),
    );
    expect(rows.map((row) => [row.subjectId, row.gradeLevel, row.targetMinutesPerWeek])).toEqual([
      [EN, 8, 140],
      [MA, 8, 180],
      [SV, 8, 175],
    ]);
  });

  it('reads a 2028 plan row for row in a TIOARIG year, and nothing for a row it lacks', () => {
    const { rows } = proposeRequirements(
      input({ gradeLevels: [8], classes: [{ id: A7, name: '8A', gradeLevel: 8 }], planTioarig: true, gradeNumbering: 'TIOARIG' }),
    );
    expect(rows).toEqual([]);
  });
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

  describe('a line the class’s halves read (Dela terminsvis i halvklass)', () => {
    const SL = 'd5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5';
    const TX = 'd6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6';
    const TM = 'd7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7';
    const KE = 'd8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8';
    const BI = 'd9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9';
    const split = (over: Partial<GenerateInput> = {}): GenerateInput =>
      input({
        entries: [
          { subjectId: SL, gradeLevel: 7, minutesPerWeek: 90 },
          { subjectId: KE, gradeLevel: 7, minutesPerWeek: 60 },
          { subjectId: MA, gradeLevel: 7, minutesPerWeek: 180 },
        ],
        subjectNames: new Map([
          [SL, 'Slöjd'],
          [TX, 'Textilslöjd'],
          [TM, 'Trä- och metallslöjd'],
          [KE, 'Kemi'],
          [BI, 'Biologi'],
          [MA, 'Matematik'],
        ]),
        nationalCodes: new Map([
          [SL, 'SL'],
          [TX, 'SL'],
          [TM, 'SL'],
          [KE, 'KE'],
          [BI, 'BI'],
          [MA, 'MA'],
        ]),
        // 7A after the split: Textilslöjd and Trä- och metallslöjd on both
        // halves, and a Biologi post on 7A:1 that fills no other line.
        halfPosts: [
          { classId: A7, halfName: '7A:2', subjectId: TX },
          { classId: A7, halfName: '7A:1', subjectId: TX },
          { classId: A7, halfName: '7A:1', subjectId: TM },
          { classId: A7, halfName: '7A:2', subjectId: TM },
          { classId: A7, halfName: '7A:1', subjectId: BI },
        ],
        ...over,
      });

    it('skips the class’s Slöjd, which its halves read as Textilslöjd and Trä- och metallslöjd, naming the halves', () => {
      const { rows, skipped } = proposeRequirements(split());

      expect(skipped).toEqual([
        {
          studentGroupId: A7,
          groupName: '7A',
          subjectId: SL,
          subjectName: 'Slöjd',
          gradeLevel: 7,
          reason: 'HALVES',
          alternativeCode: null,
          alternativeTo: null,
          halves: ['7A:1', '7A:2'],
        },
      ]);
      // 7A still gets every other line, Kemi too (Biologi is another code),
      // and 7B, which has no halves, gets Slöjd.
      expect(rows.map((row) => `${row.groupName} ${row.subjectName}`)).toEqual([
        '7A Kemi',
        '7A Matematik',
        '7B Kemi',
        '7B Matematik',
        '7B Slöjd',
      ]);
    });

    it('skips an entry a half has in the very subject', () => {
      const { skipped } = proposeRequirements(split({ halfPosts: [{ classId: A7, halfName: '7A:2', subjectId: KE }] }));

      expect(skipped.map((row) => [row.subjectName, row.reason, row.halves])).toEqual([['Kemi', 'HALVES', ['7A:2']]]);
    });

    it('says EXISTS, not HALVES, for a pair the class has itself', () => {
      const { skipped } = proposeRequirements(split({ existing: [{ studentGroupId: A7, subjectId: SL }] }));

      expect(skipped.map((row) => [row.subjectName, row.reason])).toEqual([['Slöjd', 'EXISTS']]);
    });

    it('answers as before for a school that splits no class', () => {
      const without = proposeRequirements(split({ halfPosts: undefined }));

      expect(without.skipped).toEqual([]);
      expect(without.rows.map((row) => `${row.groupName} ${row.subjectName}`)).toContain('7A Slöjd');
    });
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

    describe('M2 on the språkval groups, as a block (Parallella block)', () => {
      const TY7 = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
      const SP7 = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
      const named = (over: Partial<GenerateInput> = {}) =>
        alternatives({
          languageGroups: [
            { gradeLevel: 7, subjectId: DE, studentGroupId: TY7, groupName: 'Ty7' },
            { gradeLevel: 7, subjectId: ES, studentGroupId: SP7, groupName: 'Sp7' },
          ],
          ...over,
        });

      it('posts each language on its group, all of an årskurs in one block, and still none on the class', () => {
        const { rows, skipped, blocks } = proposeRequirements(named());
        expect(rows.map((row) => [row.groupName, row.subjectName, row.lessonsPerWeek, row.minutesPerLesson, row.blockName ?? null])).toEqual([
          ['7A', 'Matematik', 3, 60, null],
          ['7A', 'Svenska', 3, 60, null],
          ['Sp7', 'Spanska', 2, 60, 'Språkval åk 7'],
          ['Ty7', 'Tyska', 2, 60, 'Språkval åk 7'],
        ]);
        expect(blocks).toEqual([{ name: 'Språkval åk 7', gradeLevel: 7 }]);
        // The class still reads no språkval of its own.
        expect(skipped.filter((row) => row.alternativeCode === 'M2').map((row) => [row.groupName, row.reason])).toEqual([
          ['7A', 'ALTERNATIVE'],
          ['7A', 'ALTERNATIVE'],
        ]);
      });

      it('gives every row of the block the line’s highest target, laid out once', () => {
        const { rows } = proposeRequirements(
          named({
            remainder: 'SPLIT',
            entries: [
              { subjectId: ES, gradeLevel: 7, minutesPerWeek: 110 },
              { subjectId: DE, gradeLevel: 7, minutesPerWeek: 100 },
            ],
          }),
        );
        expect(rows.map((row) => [row.subjectName, row.targetMinutesPerWeek, row.lessonsPerWeek, row.minutesPerLesson, row.lessonLengths])).toEqual([
          ['Spanska', 110, 2, 60, [60, 50]],
          ['Tyska', 110, 2, 60, [60, 50]],
        ]);
      });

      it('skips a group that already reads its language, and makes no block for an årskurs it leaves empty', () => {
        const { rows, skipped, blocks } = proposeRequirements(
          named({
            languageGroups: [{ gradeLevel: 7, subjectId: DE, studentGroupId: TY7, groupName: 'Ty7' }],
            existing: [{ studentGroupId: TY7, subjectId: DE }],
          }),
        );
        expect(rows.some((row) => row.blockName)).toBe(false);
        expect(blocks).toEqual([]);
        expect(skipped).toContainEqual(
          expect.objectContaining({ groupName: 'Ty7', subjectName: 'Tyska', reason: 'EXISTS', alternativeCode: 'M2' }),
        );
      });

      it('answers without blocks, as it always did, when no group is named', () => {
        expect(proposeRequirements(alternatives())).not.toHaveProperty('blocks');
        expect(proposeRequirements(alternatives({ languageGroups: [] }))).not.toHaveProperty('blocks');
      });

      it.each([
        [{ gradeLevel: 7, subjectId: MA, studentGroupId: TY7, groupName: 'Ty7' }, /rad 1: Matematik är inget språkval/],
        [{ gradeLevel: 8, subjectId: DE, studentGroupId: TY7, groupName: 'Ty7' }, /rad 1: läsåret följer inte den här timplanen i åk 8/],
      ])('refuses a group named for what is no språkval of the year', (choice, message) => {
        expect(() => proposeRequirements(alternatives({ languageGroups: [choice] }))).toThrow(message);
      });

      it('posts a language read by several groups on each of them, all in the årskurs’ one block', () => {
        const SP7B = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
        const SP7C = 'e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4';
        const { rows, blocks } = proposeRequirements(
          named({
            languageGroups: [
              { gradeLevel: 7, subjectId: ES, studentGroupId: SP7C, groupName: '7sp3' },
              { gradeLevel: 7, subjectId: ES, studentGroupId: SP7, groupName: '7sp1' },
              { gradeLevel: 7, subjectId: DE, studentGroupId: TY7, groupName: 'Ty7' },
              { gradeLevel: 7, subjectId: ES, studentGroupId: SP7B, groupName: '7sp2' },
            ],
          }),
        );
        expect(
          rows.filter((row) => row.blockName).map((row) => [row.groupName, row.subjectName, row.lessonsPerWeek, row.minutesPerLesson, row.blockName]),
        ).toEqual([
          ['7sp1', 'Spanska', 2, 60, 'Språkval åk 7'],
          ['7sp2', 'Spanska', 2, 60, 'Språkval åk 7'],
          ['7sp3', 'Spanska', 2, 60, 'Språkval åk 7'],
          ['Ty7', 'Tyska', 2, 60, 'Språkval åk 7'],
        ]);
        expect(blocks).toEqual([{ name: 'Språkval åk 7', gradeLevel: 7 }]);
      });

      it('refuses a language without minutes, and a group named twice for the same language or another', () => {
        expect(() =>
          proposeRequirements(
            named({ entries: [{ subjectId: ES, gradeLevel: 7, minutesPerWeek: 120 }, { subjectId: DE, gradeLevel: 7, minutesPerWeek: 0 }] }),
          ),
        ).toThrow(/rad 1: timplanen ger Tyska ingen tid i åk 7/);
        expect(() =>
          proposeRequirements(
            named({
              languageGroups: [
                { gradeLevel: 7, subjectId: ES, studentGroupId: SP7, groupName: 'Sp7' },
                { gradeLevel: 7, subjectId: ES, studentGroupId: SP7, groupName: 'Sp7' },
              ],
            }),
          ),
        ).toThrow(/rad 2: Sp7 är redan vald för Spanska i åk 7/);
        expect(() =>
          proposeRequirements(
            named({
              languageGroups: [
                { gradeLevel: 7, subjectId: DE, studentGroupId: TY7, groupName: 'Ty7' },
                { gradeLevel: 7, subjectId: ES, studentGroupId: TY7, groupName: 'Ty7' },
              ],
            }),
          ),
        ).toThrow(/rad 2: Ty7 är redan vald för Tyska i åk 7/);
      });

      it('takes no override on a row of the block', () => {
        expect(() =>
          proposeRequirements(
            named({ overrides: [{ studentGroupId: TY7, subjectId: DE, lessonsPerWeek: 3, minutesPerLesson: 60 }] }),
          ),
        ).toThrow(/overrides: språkvalets rader läggs i ett block/);
      });
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
