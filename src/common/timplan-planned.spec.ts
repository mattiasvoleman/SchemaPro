import { teachingWeeks } from '../staffing/teaching-weeks';
import {
  computePlannedCoverage,
  type PlannedCoverageInput,
  type PlannedGroup,
  type PlannedPlan,
  type PlannedRequirement,
  type PlannedSubject,
} from './timplan-planned';

/*
 * The rules of planerat mot timplan, each pinned by a hand-computed number.
 * The shared fixture (timplan-planned.contract.spec.ts) pins the whole
 * document against its own past; these say WHY a figure is what it is.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S = {
  MA: id(1),
  SV: id(2),
  SVA: id(3),
  EN: id(4),
  SPA: id(5),
  TY: id(6),
  MENT: id(7),
};
const SUBJECTS: PlannedSubject[] = [
  { id: S.MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
  { id: S.SV, name: 'Svenska', nationalCode: 'SV_SVA', countsTowardTimplan: true },
  { id: S.SVA, name: 'Svenska som andraspråk', nationalCode: 'SV_SVA', countsTowardTimplan: true },
  { id: S.EN, name: 'Engelska', nationalCode: 'EN', countsTowardTimplan: true },
  { id: S.SPA, name: 'Spanska', nationalCode: 'M2', countsTowardTimplan: true },
  { id: S.TY, name: 'Tyska', nationalCode: 'M2', countsTowardTimplan: true },
  { id: S.MENT, name: 'Mentorstid', nationalCode: null, countsTowardTimplan: false },
];
const PLAN = id(100);
const DRAFT = id(101);
const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };

const plan = (
  entries: [string, number, number][],
  overrides: Partial<PlannedPlan> = {},
): PlannedPlan => ({
  id: PLAN,
  name: 'Grundskolan 2024',
  status: 'DECIDED',
  entries: entries.map(([subjectId, gradeLevel, minutesPerWeek]) => ({ subjectId, gradeLevel, minutesPerWeek })),
  ...overrides,
});

let serial = 1000;
const group = (name: string, kind: PlannedGroup['kind'] = 'CLASS', gradeLevel: number | null = 7): PlannedGroup => ({
  id: id(serial++),
  name,
  kind,
  gradeLevel,
});
const req = (
  g: PlannedGroup,
  subjectId: string,
  lessonsPerWeek: number,
  minutesPerLesson: number,
  extra: Partial<PlannedRequirement> = {},
): PlannedRequirement => ({
  id: id(serial++),
  studentGroupId: g.id,
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...extra,
});
const pupil = (home: PlannedGroup | null, groups: PlannedGroup[] = []) => ({
  id: id(serial++),
  homeGroupId: home?.id ?? null,
  groupIds: groups.map((g) => g.id),
});

const input = (over: Partial<PlannedCoverageInput>): PlannedCoverageInput => ({
  year: YEAR,
  closures: [],
  plans: [plan([[S.MA, 7, 180]])],
  attachments: [{ gradeLevel: 7, localTimplanId: PLAN }],
  subjects: SUBJECTS,
  groups: [],
  requirements: [],
  pupils: [],
  includePupils: true,
  ...over,
});

const lineOf = (coverage: ReturnType<typeof computePlannedCoverage>, groupId: string, key: string) =>
  coverage.groups.find((g) => g.studentGroupId === groupId)!.lines.find((l) => l.key === key)!;

describe('computePlannedCoverage', () => {
  describe('the standardvecka', () => {
    it('halves an odd- or even-week row, and adds the two halves back to a whole week', () => {
      const c = group('7A');
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.MA, 7, 180], [S.EN, 7, 160]])],
          groups: [c],
          requirements: [
            req(c, S.MA, 6, 60, { recurrence: 'ODD_WEEKS' }),
            req(c, S.EN, 2, 80, { recurrence: 'EVEN_WEEKS' }),
            req(c, S.EN, 2, 80, { recurrence: 'ODD_WEEKS' }),
          ],
        }),
      );
      expect(lineOf(coverage, c.id, `subject:${S.MA}`)).toMatchObject({
        plannedMinutesPerWeek: 180,
        status: 'MET',
      });
      expect(lineOf(coverage, c.id, `subject:${S.EN}`)).toMatchObject({
        plannedMinutesPerWeek: 160,
        status: 'MET',
      });
      expect(coverage.verdicts).toEqual([]);
    });

    it('weighs a dated row by its share of the teaching weeks, lov subtracted, for the class’s own årskurs', () => {
      const c = group('2A', 'CLASS', 2);
      const closures = [
        { startDate: '2027-02-15', endDate: '2027-02-19' },
        { startDate: '2027-01-08', endDate: '2027-01-08', minGradeLevel: 1, maxGradeLevel: 3 },
      ];
      const spring = { startDate: '2027-01-04', endDate: '2027-06-11' };
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.MA, 2, 200]])],
          attachments: [{ gradeLevel: 2, localTimplanId: PLAN }],
          closures,
          groups: [c],
          requirements: [req(c, S.MA, 4, 50, spring)],
        }),
      );
      const share =
        teachingWeeks(spring, YEAR, closures, 2) / teachingWeeks({}, YEAR, closures, 2);
      const line = lineOf(coverage, c.id, `subject:${S.MA}`);
      expect(line.plannedMinutesPerWeek).toBe(Math.round(200 * share));
      expect(line.plannedHours).toBe(Math.round((200 * teachingWeeks(spring, YEAR, closures, 2)) / 6) / 10);
      expect(line.targetHours).toBe(Math.round((200 * teachingWeeks({}, YEAR, closures, 2)) / 6) / 10);
      expect(line.status).toBe('UNDER');
      // The studiedag is åk 1–3's: the same row in åk 7 weighs more.
      const c7 = group('7A');
      const seven = computePlannedCoverage(
        input({ closures, groups: [c7], requirements: [req(c7, S.MA, 4, 50, spring)] }),
      );
      expect(lineOf(seven, c7.id, `subject:${S.MA}`).plannedHours).toBeGreaterThan(line.plannedHours);
    });
  });

  describe('the class', () => {
    it('reads 175 planned as 3 × 60 as MET +5, and 240 as OVER: a whole lesson could go', () => {
      const a = group('9A', 'CLASS', 9);
      const b = group('9B', 'CLASS', 9);
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.MA, 9, 175]])],
          attachments: [{ gradeLevel: 9, localTimplanId: PLAN }],
          groups: [a, b],
          requirements: [req(a, S.MA, 3, 60), req(b, S.MA, 4, 60)],
        }),
      );
      expect(lineOf(coverage, a.id, `subject:${S.MA}`)).toMatchObject({
        deltaMinutesPerWeek: 5,
        status: 'MET',
        covered: true,
      });
      expect(lineOf(coverage, b.id, `subject:${S.MA}`)).toMatchObject({
        deltaMinutesPerWeek: 65,
        status: 'OVER',
      });
      expect(coverage.verdicts).toEqual([
        expect.objectContaining({
          code: 'TIMPLAN_GROUP_OVERPLANNED',
          severity: 'notice',
          studentGroupId: b.id,
          params: expect.objectContaining({ surplusMinutesPerWeek: 65, groupName: '9B' }),
        }),
      ]);
    });

    it('measures the surplus against the smallest WEIGHTED lesson: half an odd-week lesson is enough to be OVER', () => {
      const c = group('7A');
      const coverage = computePlannedCoverage(
        input({
          groups: [c],
          requirements: [req(c, S.MA, 3, 60), req(c, S.MA, 1, 60, { recurrence: 'ODD_WEEKS' })],
        }),
      );
      // 180 + 30: removing the odd-week lesson still meets the target.
      expect(lineOf(coverage, c.id, `subject:${S.MA}`)).toMatchObject({
        plannedMinutesPerWeek: 210,
        status: 'OVER',
      });
    });

    it('says UNPLANNED for nothing, UNDER for too little, with the deficit in minutes', () => {
      const c = group('7A');
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.MA, 7, 180], [S.EN, 7, 160]])],
          groups: [c],
          requirements: [req(c, S.MA, 2, 60)],
        }),
      );
      expect(coverage.verdicts.map((v) => [v.code, v.params.deficitMinutesPerWeek])).toEqual([
        ['TIMPLAN_GROUP_UNPLANNED', 160],
        ['TIMPLAN_GROUP_UNDERPLANNED', 60],
      ]);
      expect(coverage.groups[0]).toMatchObject({ linesWithTarget: 2, linesCovered: 0 });
    });

    it('leaves mentorstid out of every figure, the class totals included', () => {
      const c = group('7A');
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.MA, 7, 180], [S.MENT, 7, 20]])],
          groups: [c],
          requirements: [req(c, S.MA, 3, 60), req(c, S.MENT, 1, 20)],
        }),
      );
      expect(coverage.groups[0]).toMatchObject({ plannedMinutesPerWeek: 180, targetMinutesPerWeek: 180 });
      expect(coverage.cells.map((cell) => cell.subjectId)).toEqual([S.MA]);
    });
  });

  describe('alternatives', () => {
    it('meets SV_SVA with Svenska alone, and takes the highest target among the alternatives', () => {
      const c = group('7A');
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.SV, 7, 200], [S.SVA, 7, 260]])],
          groups: [c],
          requirements: [req(c, S.SV, 4, 65)],
        }),
      );
      const line = lineOf(coverage, c.id, 'alt:SV_SVA');
      expect(line).toMatchObject({
        subjectIds: [S.SV, S.SVA],
        targetMinutesPerWeek: 260,
        plannedMinutesPerWeek: 260,
        status: 'MET',
      });
      // Both cells shown, the line's status on each: SvA's 0 / 260 is not red.
      expect(coverage.cells.filter((cell) => cell.alternativeCode === 'SV_SVA')).toEqual([
        expect.objectContaining({ subjectId: S.SV, targetMinutesPerWeek: 200, plannedMinutesPerWeek: 260, status: 'MET' }),
        expect.objectContaining({ subjectId: S.SVA, targetMinutesPerWeek: 260, plannedMinutesPerWeek: 0, status: 'MET' }),
      ]);
      // The class's target total counts the line once, at its highest target.
      expect(coverage.groups[0]!.targetMinutesPerWeek).toBe(260);
    });

    it('judges a class whose språkval is taught in teaching groups through its pupils, and names the one without', () => {
      const c = group('8A', 'CLASS', 8);
      const spanska = group('Spanska 8', 'TEACHING_GROUP', null);
      const tyska = group('Tyska 8', 'TEACHING_GROUP', null);
      const withSpanska = pupil(c, [spanska]);
      const withTyska = pupil(c, [tyska]);
      const without = pupil(c);
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.SPA, 8, 90], [S.TY, 8, 90]])],
          attachments: [{ gradeLevel: 8, localTimplanId: PLAN }],
          groups: [c, spanska, tyska],
          requirements: [req(spanska, S.SPA, 3, 30), req(tyska, S.TY, 2, 45)],
          pupils: [withSpanska, withTyska, without],
        }),
      );
      const line = lineOf(coverage, c.id, 'alt:M2');
      expect(line).toMatchObject({
        plannedMinutesPerWeek: 0,
        status: 'PUPILS',
        covered: false,
        teachingGroupIds: [spanska.id, tyska.id],
        pupils: { min: 0, median: 90, max: 90, below: 1 },
      });
      expect(coverage.verdicts).toEqual([
        expect.objectContaining({
          code: 'TIMPLAN_PUPIL_UNDERPLANNED',
          pupilId: without.id,
          alternativeCode: 'M2',
          subjectIds: [S.SPA, S.TY],
          params: expect.objectContaining({ subjectName: 'Spanska / Tyska', deficitMinutesPerWeek: 90 }),
        }),
      ]);
      expect(coverage.pupils!.map((p) => p.pupilId)).toEqual([without.id]);
      expect(coverage.pupilsBelowTarget).toBe(1);
    });

    it('meets the line for a pupil reading SvA in a group on top of the class’s Svenska', () => {
      const c = group('7A');
      const sva = group('SvA 7', 'TEACHING_GROUP', 7);
      const reader = pupil(c, [sva]);
      const other = pupil(c);
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.SV, 7, 200], [S.SVA, 7, 200]])],
          groups: [c, sva],
          requirements: [req(c, S.SV, 3, 60), req(sva, S.SVA, 1, 60)],
          pupils: [reader, other],
        }),
      );
      // The class gives 180 of 200; the SvA group lifts its reader to 240.
      expect(lineOf(coverage, c.id, 'alt:SV_SVA')).toMatchObject({ status: 'PUPILS', pupils: { min: 180, max: 240, below: 1 } });
      expect(coverage.verdicts.map((v) => [v.code, v.pupilId])).toEqual([['TIMPLAN_PUPIL_UNDERPLANNED', other.id]]);
      // Svenska and SvA are two subjects: reading both is not double planning.
      expect(coverage.verdicts.some((v) => v.code === 'TIMPLAN_PUPIL_DOUBLE_PLANNED')).toBe(false);
    });
  });

  describe('the pupil', () => {
    it('flags the same subject from the class and a group, and from two groups, with the groups named', () => {
      const c = group('7A');
      const fordjupning = group('Ma-fördjupning', 'TEACHING_GROUP', 7);
      const niva = group('Ma nivå', 'TEACHING_GROUP', 7);
      const both = pupil(c, [fordjupning]);
      const twoGroups = pupil(group('7B'), []);
      const groups = [c, fordjupning, niva];
      const c7b = { id: twoGroups.homeGroupId!, name: '7B', kind: 'CLASS' as const, gradeLevel: 7 };
      const twoGroupsPupil = { ...twoGroups, groupIds: [fordjupning.id, niva.id] };
      const coverage = computePlannedCoverage(
        input({
          groups: [...groups, c7b],
          requirements: [req(c, S.MA, 3, 60), req(fordjupning, S.MA, 1, 60), req(niva, S.MA, 2, 60)],
          pupils: [both, twoGroupsPupil],
        }),
      );
      const doubles = coverage.verdicts.filter((v) => v.code === 'TIMPLAN_PUPIL_DOUBLE_PLANNED');
      expect(doubles.map((v) => [v.pupilId, v.params.groupNames, v.params.plannedMinutesPerWeek])).toEqual([
        [both.id, '7A, Ma-fördjupning', 240],
        [twoGroupsPupil.id, 'Ma nivå, Ma-fördjupning', 180],
      ]);
      // Listed with every source, so the drill-down shows where the minutes come from.
      const listed = coverage.pupils!.find((p) => p.pupilId === both.id)!;
      expect(listed.lines[0]!.sources).toEqual([
        { studentGroupId: c.id, subjectId: S.MA, minutesPerWeek: 180 },
        { studentGroupId: fordjupning.id, subjectId: S.MA, minutesPerWeek: 60 },
      ]);
    });

    it('sums a pupil in two teaching groups of different subjects, and keeps quiet when that meets the plan', () => {
      const c = group('8A', 'CLASS', 8);
      const spanska = group('Spanska', 'TEACHING_GROUP', 8);
      const engelska = group('Engelska fördjupning', 'TEACHING_GROUP', 8);
      const p = pupil(c, [spanska, engelska]);
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.SPA, 8, 90], [S.EN, 8, 160]])],
          attachments: [{ gradeLevel: 8, localTimplanId: PLAN }],
          groups: [c, spanska, engelska],
          requirements: [req(spanska, S.SPA, 3, 30), req(c, S.EN, 1, 80), req(engelska, S.EN, 1, 80)],
          pupils: [p],
        }),
      );
      expect(coverage.pupilsBelowTarget).toBe(0);
      expect(coverage.verdicts.map((v) => v.code)).toEqual(['TIMPLAN_PUPIL_DOUBLE_PLANNED']);
      expect(coverage.groups[0]).toMatchObject({ linesWithTarget: 2, linesCovered: 2 });
    });

    it('does not repeat a short class once per pupil: the class verdict says it, the pupils are counted', () => {
      const c = group('7A');
      const pupils = [pupil(c), pupil(c), pupil(c)];
      const coverage = computePlannedCoverage(
        input({ groups: [c], requirements: [req(c, S.MA, 2, 60)], pupils }),
      );
      expect(coverage.verdicts.map((v) => v.code)).toEqual(['TIMPLAN_GROUP_UNDERPLANNED']);
      expect(coverage.pupils).toEqual([]);
      expect(coverage.pupilsBelowTarget).toBe(3);
      expect(coverage.groups[0]!.lines[0]!.pupils).toEqual({ min: 120, median: 120, max: 120, below: 3 });
    });

    it('counts pupils without a class this year, and judges nobody without an årskurs', () => {
      const ungraded = group('Resurs', 'CLASS', null);
      const coverage = computePlannedCoverage(
        input({
          groups: [ungraded],
          requirements: [req(ungraded, S.MA, 3, 60)],
          pupils: [pupil(ungraded), pupil(null), { id: id(9999), homeGroupId: id(8888), groupIds: [] }],
        }),
      );
      expect(coverage.pupilsOutsideClasses).toBe(2);
      expect(coverage.groups[0]).toMatchObject({ gradeLevel: null, localTimplanId: null });
      expect(coverage.groups[0]!.lines[0]!.status).toBe('NO_TARGET');
      expect(coverage.verdicts).toEqual([]);
    });
  });

  describe('the year', () => {
    it('names an årskurs with classes and no plan once, with its classes, and judges none of them', () => {
      const a = group('6A', 'CLASS', 6);
      const b = group('6B', 'CLASS', 6);
      const coverage = computePlannedCoverage(
        input({ groups: [b, a], requirements: [req(a, S.MA, 3, 60)] }),
      );
      expect(coverage.verdicts).toEqual([
        {
          code: 'TIMPLAN_YEAR_GRADE_UNATTACHED',
          severity: 'notice',
          gradeLevel: 6,
          studentGroupIds: [a.id, b.id],
          params: { gradeLevel: 6, groupCount: 2, groupNames: '6A, 6B' },
        },
      ]);
      expect(coverage.groups.map((g) => g.lines.map((l) => l.status))).toEqual([['NO_TARGET'], []]);
    });

    it('marks a draft plan, and still judges the classes that follow it', () => {
      const c = group('9A', 'CLASS', 9);
      const coverage = computePlannedCoverage(
        input({
          plans: [plan([[S.MA, 9, 180]], { id: DRAFT, name: 'Grundskolan 2027', status: 'DRAFT' })],
          attachments: [
            { gradeLevel: 8, localTimplanId: DRAFT },
            { gradeLevel: 9, localTimplanId: DRAFT },
          ],
          groups: [c],
          requirements: [req(c, S.MA, 2, 60)],
        }),
      );
      expect(coverage.verdicts.map((v) => v.code)).toEqual([
        'TIMPLAN_ATTACHED_DRAFT',
        'TIMPLAN_GROUP_UNDERPLANNED',
      ]);
      expect(coverage.verdicts[0]).toMatchObject({
        localTimplanId: DRAFT,
        gradeLevels: [8, 9],
        params: { planName: 'Grundskolan 2027', gradeLevels: '8, 9' },
      });
      expect(coverage.groups[0]).toMatchObject({ localTimplanId: DRAFT, planStatus: 'DRAFT' });
    });
  });

  describe('the teacher’s read', () => {
    it('carries no pupil figure and no pupil verdict, and the same class coverage', () => {
      const c = group('8A', 'CLASS', 8);
      const spanska = group('Spanska 8', 'TEACHING_GROUP', 8);
      const world = input({
        plans: [plan([[S.SPA, 8, 90]])],
        attachments: [{ gradeLevel: 8, localTimplanId: PLAN }],
        groups: [c, spanska],
        requirements: [req(spanska, S.SPA, 3, 30)],
        pupils: [pupil(c, [spanska]), pupil(c)],
      });
      const admin = computePlannedCoverage(world);
      const teacher = computePlannedCoverage({ ...world, includePupils: false });
      expect(teacher.pupils).toBeNull();
      expect(teacher.pupilsBelowTarget).toBeNull();
      expect(teacher.verdicts).toEqual([]);
      expect(admin.verdicts.map((v) => v.code)).toEqual(['TIMPLAN_PUPIL_UNDERPLANNED']);
      expect(teacher.groups[0]!.lines[0]!.pupils).toBeUndefined();
      expect(teacher.groups[0]).toMatchObject({ linesCovered: 0, linesWithTarget: 1, pupilCount: 2 });
      expect(JSON.stringify(teacher)).not.toContain(world.pupils[0]!.id);
    });
  });

  describe('a 600-pupil school', () => {
    it('is computed well inside the endpoint’s two seconds', () => {
      const subjects: PlannedSubject[] = [...SUBJECTS];
      for (let n = 0; n < 10; n += 1) {
        subjects.push({ id: id(200 + n), name: `Ämne ${n}`, nationalCode: null, countsTowardTimplan: true });
      }
      const entries: [string, number, number][] = [];
      for (const grade of [7, 8, 9]) {
        for (const s of subjects) entries.push([s.id, grade, 120]);
      }
      const groups: PlannedGroup[] = [];
      const requirements: PlannedRequirement[] = [];
      const pupils: ReturnType<typeof pupil>[] = [];
      for (const grade of [7, 8, 9]) {
        const language = [group(`Spanska ${grade}`, 'TEACHING_GROUP', grade), group(`Tyska ${grade}`, 'TEACHING_GROUP', grade)];
        groups.push(...language);
        requirements.push(req(language[0]!, S.SPA, 2, 60), req(language[1]!, S.TY, 2, 60));
        for (let k = 0; k < 8; k += 1) {
          const c = group(`${grade}${'ABCDEFGH'[k]}`, 'CLASS', grade);
          groups.push(c);
          for (const s of subjects) {
            if (s.nationalCode === 'M2' || s.id === S.SVA) continue;
            requirements.push(req(c, s.id, 2, 60, k % 2 ? { recurrence: 'ODD_WEEKS' } : {}));
          }
          for (let p = 0; p < 25; p += 1) pupils.push(pupil(c, [language[p % 2]!]));
        }
      }
      const world = input({
        plans: [plan(entries)],
        attachments: [7, 8, 9].map((gradeLevel) => ({ gradeLevel, localTimplanId: PLAN })),
        closures: [{ startDate: '2026-11-02', endDate: '2026-11-06' }],
        subjects,
        groups,
        requirements,
        pupils,
      });

      const started = performance.now();
      const coverage = computePlannedCoverage(world);
      const elapsed = performance.now() - started;

      expect(pupils).toHaveLength(600);
      expect(coverage.pupilCount).toBe(600);
      expect(coverage.groups).toHaveLength(24);
      expect(elapsed).toBeLessThan(2000);
    });
  });
});
