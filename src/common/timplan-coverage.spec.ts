import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  checkLocalTimplan,
  planningWeeksInTenths,
  stageGradesFor,
  type CoverageEntry,
  type CoverageNationalSubject,
  type CoverageSubject,
  type CoverageVersion,
  type SchoolForm,
  type TimplanCheck,
  type TimplanStage,
  type TimplanVerdictCode,
} from './timplan-coverage';

/*
 * The statute these cases are checked against is read out of P0's migration —
 * the very rows the database is seeded with — rather than retyped here. A case
 * that says "matematik lågstadiet is 420 h" is then a case about the seed, and
 * a second transcription that could disagree with the first does not exist.
 */
const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20261006090000_den_nationella_timplanen_ar_referensdata/migration.sql',
);

interface Statute {
  versions: Map<string, CoverageVersion>;
  subjects: CoverageNationalSubject[];
}

function readStatute(): Statute {
  const sql = readFileSync(MIGRATION, 'utf8');

  const subjectBlock = sql.slice(
    sql.indexOf('INSERT INTO "NationalSubjects"'),
    sql.indexOf('INSERT INTO "NationalTimplanVersions"'),
  );
  const subjects: CoverageNationalSubject[] = [
    ...subjectBlock.matchAll(/\('([A-Z0-9_]+)',\s*'[^']+',\s*(NULL|'[A-Z0-9_]+'),\s*(?:true|false)\)/g),
  ].map((m) => ({ code: m[1]!, parentCode: m[2] === 'NULL' ? null : m[2]!.slice(1, -1) }));

  const versions = new Map<string, CoverageVersion>();
  for (const m of sql.matchAll(
    /\('(SFS[^']+)',\s*'[^']*',\s*'[^']*',\s*'([A-Z_]+)',\s*(\d+),\s*(NULL|\d+),\s*(NULL|\d+),\s*'((?:HT|VT)\d{4})',\s*(?:NULL|'[^']*')\)/g,
  )) {
    versions.set(m[1]!, {
      code: m[1]!,
      schoolForm: m[2] as SchoolForm,
      totalHours: Number(m[3]),
      skolansValHours: m[4] === 'NULL' ? null : Number(m[4]),
      reductionCapPercent: m[5] === 'NULL' ? null : Number(m[5]),
      appliesFromCohortTerm: m[6]!,
      entries: [],
    });
  }

  for (const block of sql.split('CROSS JOIN (VALUES').slice(1)) {
    const code = /WHERE v\.code = '([^']+)'/.exec(block)![1]!;
    const body = block.slice(0, block.indexOf(') AS e('));
    for (const m of body.matchAll(
      /\('([A-Z0-9_]+)',\s*'([A-Z_]+)',\s*(\d+)(?:,\s*(NULL|\d+),\s*(true|false))?\)/g,
    )) {
      versions.get(code)!.entries.push({
        subjectCode: m[1]!,
        stage: m[2] as TimplanStage,
        hours: Number(m[3]),
        minimumHoursPerChild: m[4] === undefined || m[4] === 'NULL' ? null : Number(m[4]),
        protectedFromReduction: m[5] === 'true',
      });
    }
  }
  return { versions, subjects };
}

const STATUTE = readStatute();
const B1 = 'SFS2023:945/B1';
const B2A = 'SFS2022:1619/B2A';
const B2B = 'SFS2022:1619/B2B';
const B3 = 'SFS2023:945/B3';
const B4 = 'SFS2023:945/B4';
const LAW_2028 = 'SFS2025:729';

const version = (code: string): CoverageVersion => STATUTE.versions.get(code)!;
const parentOf = new Map(STATUTE.subjects.map((s) => [s.code, s.parentCode]));
const cellOf = (code: string, stage: TimplanStage) =>
  version(B1).entries.find((e) => e.subjectCode === code && e.stage === stage)!;

/** A school subject per national code: id `s-MA`, name the code. */
const coded = (code: string, overrides: Partial<CoverageSubject> = {}): CoverageSubject => ({
  id: `s-${code}`,
  name: code,
  nationalCode: code,
  countsTowardTimplan: true,
  ...overrides,
});

/** `total` minutes a week spread over the grades, the first ones taking the remainder. */
function spread(subjectId: string, total: number, grades: number[]): CoverageEntry[] {
  const base = Math.floor(total / grades.length);
  const extra = total - base * grades.length;
  return grades.map((gradeLevel, index) => ({
    subjectId,
    gradeLevel,
    minutesPerWeek: base + (index < extra ? 1 : 0),
  }));
}

/** The fewest minutes a week whose year, at these weeks, reaches `hours`. */
const minutesFor = (hours: number, weeksTenths: number): number =>
  Math.ceil((hours * 600) / weeksTenths);

function gradesOf(v: CoverageVersion, stage: TimplanStage): number[] {
  const g = stageGradesFor(v);
  return stage === 'LAG_MELLAN' ? [...g.LAG, ...g.MELLAN] : g[stage];
}

/**
 * A plan that meets every cell of the version, and nothing more than the
 * rounding to whole minutes adds. Group cells with printed children are
 * planned per child — minimum plus an even share of the free remainder — and
 * group cells without (NO and SO in lågstadiet) as the group itself.
 */
function compliantPlan(code: string, weeksTenths: number) {
  const v = version(code);
  const subjects = new Map<string, CoverageSubject>();
  const entries: CoverageEntry[] = [];
  const plan = (nationalCode: string, hours: number, stage: TimplanStage) => {
    const subject = subjects.get(nationalCode) ?? coded(nationalCode);
    subjects.set(nationalCode, subject);
    entries.push(...spread(subject.id, minutesFor(hours, weeksTenths), gradesOf(v, stage)));
  };
  for (const cell of v.entries) {
    if (parentOf.get(cell.subjectCode)) continue;
    const children = v.entries.filter(
      (e) => parentOf.get(e.subjectCode) === cell.subjectCode && e.stage === cell.stage,
    );
    if (children.length === 0) {
      plan(cell.subjectCode, cell.hours, cell.stage);
      continue;
    }
    const free = cell.hours - children.reduce((sum, c) => sum + c.hours, 0);
    children.forEach((child, index) => {
      const share = Math.floor(free / children.length) + (index < free % children.length ? 1 : 0);
      plan(child.subjectCode, child.hours + share, cell.stage);
    });
  }
  return { subjects: [...subjects.values()], entries };
}

function check(
  code: string,
  weeksTenths: number,
  subjects: CoverageSubject[],
  entries: CoverageEntry[],
): TimplanCheck {
  return checkLocalTimplan({
    planningWeeksTenths: weeksTenths,
    version: version(code),
    nationalSubjects: STATUTE.subjects,
    subjects,
    entries,
  });
}

/** Replace every entry of one subject in one stage's grades with `perGrade`. */
function replaceStage(
  entries: CoverageEntry[],
  subjectId: string,
  grades: number[],
  perGrade: number[],
): CoverageEntry[] {
  return [
    ...entries.filter((e) => !(e.subjectId === subjectId && grades.includes(e.gradeLevel))),
    ...grades.map((gradeLevel, index) => ({ subjectId, gradeLevel, minutesPerWeek: perGrade[index]! })),
  ];
}

const codes = (result: TimplanCheck): TimplanVerdictCode[] => result.verdicts.map((v) => v.code);
const cell = (result: TimplanCheck, code: string, stage: TimplanStage) =>
  result.cells.find((c) => c.subjectCode === code && c.stage === stage)!;

describe('the statute the cases read', () => {
  it('is P0’s seed: six versions, the B1 cells and totals as the bilaga prints them', () => {
    expect([...STATUTE.versions.keys()].sort()).toEqual([B2A, B2B, LAW_2028, B1, B3, B4].sort());
    expect(version(B1)).toMatchObject({ totalHours: 6890, skolansValHours: 600, reductionCapPercent: 20 });
    expect(version(B4)).toMatchObject({ totalHours: 4473, skolansValHours: 210, reductionCapPercent: 15 });
    expect(version(LAW_2028)).toMatchObject({ totalHours: 7424, entries: [] });
    expect(['LAG', 'MELLAN', 'HOG'].map((s) => cellOf('MA', s as TimplanStage).hours)).toEqual([420, 410, 400]);
    expect(['LAG', 'MELLAN', 'HOG'].map((s) => cellOf('SV_SVA', s as TimplanStage).hours)).toEqual([680, 520, 290]);
    expect(cellOf('NO', 'MELLAN')).toMatchObject({ hours: 216, minimumHoursPerChild: 60 });
    expect(cellOf('HKK', 'LAG_MELLAN').hours).toBe(40);
    expect(version(B1).entries.some((e) => e.subjectCode === 'M2' && e.stage === 'LAG')).toBe(false);
    // Top-level cells only add up to the guarantee; children are inside their group.
    const top = version(B1).entries.filter((e) => !parentOf.get(e.subjectCode));
    expect(top.reduce((sum, e) => sum + e.hours, 0)).toBe(6890);
  });
});

describe('planningWeeksInTenths', () => {
  it('reads a Prisma Decimal, a number and PostgREST’s string as the same exact tenths', () => {
    expect(planningWeeksInTenths(new Prisma.Decimal('35.6'))).toBe(356);
    expect(planningWeeksInTenths(new Prisma.Decimal('36.0'))).toBe(360);
    expect(planningWeeksInTenths('35.6')).toBe(356);
    expect(planningWeeksInTenths(35.6)).toBe(356);
    expect(planningWeeksInTenths(40)).toBe(400);
    expect(planningWeeksInTenths('20.0')).toBe(200);
  });

  it('refuses what the column could not hold, and never reads a blank as 0', () => {
    for (const bad of ['', ' ', '35.65', '19.9', '40.1', 'NaN', '-35.6', '1e1', 'abc']) {
      expect(() => planningWeeksInTenths(bad)).toThrow();
    }
    expect(() => planningWeeksInTenths(Number.NaN)).toThrow();
    expect(() => planningWeeksInTenths(0)).toThrow();
  });
});

describe('stageGradesFor — keyed on the version, not on the school form alone', () => {
  it('cuts the nine-year forms 1–3 / 4–6 / 7–9', () => {
    for (const code of [B1, B2A, B2B]) {
      expect(stageGradesFor(version(code))).toEqual({ LAG: [1, 2, 3], MELLAN: [4, 5, 6], HOG: [7, 8, 9] });
    }
  });

  it('gives specialskolan its ten grades and sameskolan no högstadium', () => {
    expect(stageGradesFor(version(B3))).toEqual({ LAG: [1, 2, 3, 4], MELLAN: [5, 6, 7], HOG: [8, 9, 10] });
    expect(stageGradesFor(version(B4))).toEqual({ LAG: [1, 2, 3], MELLAN: [4, 5, 6], HOG: [] });
  });

  it('re-cuts grundskolan for the 2028 law: 1–4 / 5–7 / 8–10', () => {
    expect(stageGradesFor(version(LAW_2028))).toEqual({
      LAG: [1, 2, 3, 4],
      MELLAN: [5, 6, 7],
      HOG: [8, 9, 10],
    });
  });
});

describe('checkLocalTimplan — grundskolan, bilaga 1', () => {
  it('finds nothing to say about a plan that meets every cell at 35.6 weeks', () => {
    const { subjects, entries } = compliantPlan(B1, 356);
    const result = check(B1, 356, subjects, entries);

    expect(result.verdicts).toEqual([]);
    expect(result.distributionPublished).toBe(true);
    expect(result.planningWeeks).toBe(35.6);
    expect(result.total.guaranteedHours).toBe(6890);
    expect(result.total.plannedHours).toBeGreaterThanOrEqual(6890);
    expect(result.total.deficitHours).toBe(0);
    expect(result.skolansVal).toMatchObject({ availableHours: 600, takenHours: 0 });
    // 708 min/vecka over åk 1–3 is the fewest that reach 420 h at 35.6 weeks.
    expect(cell(result, 'MA', 'LAG')).toMatchObject({ nationalHours: 420, plannedHours: 420.1, deficitHours: 0 });
    expect(cell(result, 'MA', 'MELLAN').nationalHours).toBe(410);
    expect(cell(result, 'MA', 'HOG').nationalHours).toBe(400);
  });

  it('holds 35.6 weeks exactly: 236 + 236 + 235 min of matematik is half an hour short of 420, and protected', () => {
    const { subjects, entries } = compliantPlan(B1, 356);
    const met = check(B1, 356, subjects, replaceStage(entries, 's-MA', [1, 2, 3], [236, 236, 236]));
    expect(cell(met, 'MA', 'LAG')).toMatchObject({ plannedHours: 420.1, deficitHours: 0 });
    expect(codes(met)).toEqual([]);

    // One minute a week less in åk 3: 707 × 35.6 = 25 169.2 min = 419.49 h.
    const short = check(B1, 356, subjects, replaceStage(entries, 's-MA', [1, 2, 3], [236, 236, 235]));
    expect(cell(short, 'MA', 'LAG')).toMatchObject({
      plannedHours: 419.5,
      deficitHours: 0.6,
      reducedPercent: 0.2,
      protectedFromReduction: true,
    });
    expect(short.verdicts).toEqual([
      {
        code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED',
        severity: 'warning',
        subjectCode: 'MA',
        stage: 'LAG',
        subjectIds: ['s-MA'],
        params: { nationalHours: 420, plannedHours: 419.5, deficitHours: 0.6, reducedPercent: 0.2 },
      },
    ]);
    // The other cells' rounding to whole minutes still carries the total.
    expect(short.total.deficitHours).toBe(0);
  });

  it('flags every protected cell — svenska/SvA, engelska, språkval — reduced by one minute a week', () => {
    const { subjects, entries } = compliantPlan(B1, 300);
    for (const [code, stage] of [
      ['SV_SVA', 'HOG'],
      ['EN', 'MELLAN'],
      ['M2', 'HOG'],
    ] as const) {
      const grades = gradesOf(version(B1), stage);
      const current = entries.filter((e) => e.subjectId === `s-${code}` && grades.includes(e.gradeLevel));
      const perGrade = current.map((e, i) => e.minutesPerWeek - (i === 0 ? 1 : 0));
      const result = check(B1, 300, subjects, replaceStage(entries, `s-${code}`, grades, perGrade));
      expect(result.verdicts[0]).toMatchObject({
        code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED',
        subjectCode: code,
        stage,
        params: { deficitHours: 0.5 },
      });
    }
  });

  it('rolls Svenska and SvA into the one SV_SVA cell, and names a forgotten SvA mapping first', () => {
    const { subjects, entries } = compliantPlan(B1, 300);
    // Split svenska lågstadiet 680 h = 1 360 min/vecka at 30 weeks: 1 200 Svenska, 160 SvA.
    const sva: CoverageSubject = coded('SV_SVA', { id: 's-SVA', name: 'Svenska som andraspråk' });
    const split = [
      ...replaceStage(entries, 's-SV_SVA', [1, 2, 3], [400, 400, 400]),
      ...spread(sva.id, 160, [1, 2, 3]),
    ];
    const mapped = check(B1, 300, [...subjects, sva], split);
    expect(cell(mapped, 'SV_SVA', 'LAG')).toMatchObject({
      plannedHours: 680,
      deficitHours: 0,
      subjectIds: ['s-SVA', 's-SV_SVA'],
    });
    expect(mapped.verdicts).toEqual([]);

    const forgotten = check(B1, 300, [...subjects, { ...sva, nationalCode: null }], split);
    expect(codes(forgotten)).toEqual(['TIMPLAN_SUBJECT_UNMAPPED', 'TIMPLAN_PROTECTED_SUBJECT_REDUCED']);
    expect(forgotten.verdicts[0]).toMatchObject({
      severity: 'notice',
      params: { subjectId: 's-SVA', subjectName: 'Svenska som andraspråk', plannedHours: 80 },
    });
    // The hours are not lost: they count as the school's own, so the total holds.
    expect(forgotten.total.deficitHours).toBe(0);
    expect(forgotten.skolansVal.placedHours).toBe(80);
  });

  it('allows a cell reduced by exactly 20 %, and calls 20 % + 1 minute a week over the cap', () => {
    // 40.0 weeks: bild lågstadiet 60 h × 80 % = 48 h = 72 min/vecka exactly.
    const { subjects, entries } = compliantPlan(B1, 400);
    const atCap = check(B1, 400, subjects, replaceStage(entries, 's-BL', [1, 2, 3], [24, 24, 24]));
    expect(cell(atCap, 'BL', 'LAG')).toMatchObject({ plannedHours: 48, deficitHours: 12, reducedPercent: 20 });
    expect(atCap.verdicts).toEqual([
      expect.objectContaining({
        code: 'TIMPLAN_STAGE_BELOW_NATIONAL',
        severity: 'notice',
        subjectCode: 'BL',
        stage: 'LAG',
        params: { nationalHours: 60, plannedHours: 48, deficitHours: 12, reducedPercent: 20 },
      }),
      expect.objectContaining({ code: 'TIMPLAN_TOTAL_BELOW_GUARANTEE' }),
    ]);

    const overCap = check(B1, 400, subjects, replaceStage(entries, 's-BL', [1, 2, 3], [24, 24, 23]));
    expect(overCap.verdicts[0]).toMatchObject({
      code: 'TIMPLAN_REDUCTION_OVER_CAP',
      severity: 'warning',
      params: { nationalHours: 60, plannedHours: 47.3, deficitHours: 12.7, reducedPercent: 21.2, capPercent: 20 },
    });
  });

  it('accepts skolans val spent to the hour, and warns half an hour past the pool', () => {
    // 30.0 weeks: one minute a week is exactly half an hour a year, so every
    // reduction below is exact. 600 h taken, every cell within its 20 %, NO
    // and SO taught as integrated groups so the per-child minima are not in
    // play — and 600 h placed in Programmering, a subject with no national code.
    const weeks = 300;
    const v = version(B1);
    const reductions: [string, TimplanStage, number][] = [
      ['IDH', 'LAG', 28], ['IDH', 'MELLAN', 36], ['IDH', 'HOG', 56],
      ['SO', 'LAG', 40], ['SO', 'MELLAN', 75], ['SO', 'HOG', 81],
      ['SL', 'LAG', 10], ['SL', 'MELLAN', 28], ['SL', 'HOG', 28],
      ['MU', 'LAG', 16], ['MU', 'MELLAN', 16], ['MU', 'HOG', 16],
      ['BL', 'LAG', 12], ['BL', 'MELLAN', 16], ['BL', 'HOG', 20],
      ['NO', 'LAG', 29], ['NO', 'MELLAN', 43], ['NO', 'HOG', 50],
    ];
    expect(reductions.reduce((sum, [, , h]) => sum + h, 0)).toBe(600);

    const subjects = new Map<string, CoverageSubject>();
    let entries: CoverageEntry[] = [];
    for (const nationalCell of v.entries) {
      if (parentOf.get(nationalCell.subjectCode)) continue;
      const subject = subjects.get(nationalCell.subjectCode) ?? coded(nationalCell.subjectCode);
      subjects.set(nationalCell.subjectCode, subject);
      const cut = reductions.find(([c, s]) => c === nationalCell.subjectCode && s === nationalCell.stage)?.[2] ?? 0;
      entries.push(
        ...spread(subject.id, (nationalCell.hours - cut) * 2, gradesOf(v, nationalCell.stage)),
      );
    }
    const programmering: CoverageSubject = { id: 's-PROG', name: 'Programmering', nationalCode: null, countsTowardTimplan: true };
    entries.push(...spread(programmering.id, 1200, [7, 8, 9]));
    const all = [...subjects.values(), programmering];

    const spent = check(B1, weeks, all, entries);
    expect(spent.skolansVal).toEqual({ availableHours: 600, takenHours: 600, placedHours: 600 });
    expect(spent.total).toEqual({ plannedHours: 6890, guaranteedHours: 6890, deficitHours: 0 });
    expect(new Set(codes(spent))).toEqual(new Set(['TIMPLAN_SUBJECT_UNMAPPED', 'TIMPLAN_STAGE_BELOW_NATIONAL']));
    expect(spent.verdicts.every((v) => v.severity === 'notice')).toBe(true);
    expect(spent.verdicts.filter((v) => v.code === 'TIMPLAN_STAGE_BELOW_NATIONAL')).toHaveLength(18);
    expect(spent.verdicts[0]).toMatchObject({
      code: 'TIMPLAN_SUBJECT_UNMAPPED',
      params: { subjectName: 'Programmering', plannedHours: 600 },
    });

    // One minute a week less of teknik in åk 1: half an hour past the pool.
    const tk = entries.find((e) => e.subjectId === 's-TK' && e.gradeLevel === 1)!;
    entries = entries.map((e) => (e === tk ? { ...e, minutesPerWeek: e.minutesPerWeek - 1 } : e));
    const overspent = check(B1, weeks, all, entries);
    expect(overspent.verdicts.find((v) => v.code === 'TIMPLAN_SKOLANS_VAL_OVERSPENT')).toEqual({
      code: 'TIMPLAN_SKOLANS_VAL_OVERSPENT',
      severity: 'warning',
      params: { takenHours: 600.5, availableHours: 600, overspentHours: 0.5 },
    });
    expect(overspent.verdicts.at(-1)).toMatchObject({
      code: 'TIMPLAN_TOTAL_BELOW_GUARANTEE',
      params: { plannedHours: 6889.5, guaranteedHours: 6890, deficitHours: 0.5 },
    });
  });

  it('counts surplus in a coded subject as skolans val placed, with no verdict at all', () => {
    const { subjects, entries } = compliantPlan(B1, 300);
    // Matematik högstadiet 400 h = 800 min/vecka; a fourth lesson a week is +60.
    const more = replaceStage(entries, 's-MA', [7, 8, 9], [287, 287, 286]);
    const result = check(B1, 300, subjects, more);
    expect(result.verdicts).toEqual([]);
    expect(cell(result, 'MA', 'HOG')).toMatchObject({ plannedHours: 430, surplusHours: 30 });
    expect(result.skolansVal.placedHours).toBe(30);
  });

  it('holds each NO child to its minimum where the plan names the children, and not where it teaches NO whole', () => {
    const { subjects, entries } = compliantPlan(B1, 300);
    // NO mellanstadiet 216 h: biologi 106, fysik 60, kemi 50 — the group is
    // met, kemi is 10 h under its 60.
    let plan = replaceStage(entries, 's-BI', [4, 5, 6], [71, 71, 70]);
    plan = replaceStage(plan, 's-FY', [4, 5, 6], [40, 40, 40]);
    plan = replaceStage(plan, 's-KE', [4, 5, 6], [34, 33, 33]);
    const result = check(B1, 300, subjects, plan);
    expect(cell(result, 'NO', 'MELLAN')).toMatchObject({
      nationalHours: 216,
      plannedHours: 216,
      deficitHours: 0,
      children: [
        { subjectCode: 'BI', minimumHours: 60, plannedHours: 106 },
        { subjectCode: 'FY', minimumHours: 60, plannedHours: 60 },
        { subjectCode: 'KE', minimumHours: 60, plannedHours: 50 },
      ],
    });
    expect(result.verdicts).toEqual([
      expect.objectContaining({
        code: 'TIMPLAN_GROUP_MINIMUM_UNMET',
        severity: 'warning',
        subjectCode: 'NO',
        stage: 'MELLAN',
        childCode: 'KE',
        params: { childCode: 'KE', minimumHours: 60, plannedHours: 50, deficitHours: 10 },
      }),
    ]);

    // The same 216 h as one integrated NO subject: nothing per child to judge.
    const integrated = [
      ...entries.filter((e) => !['s-BI', 's-FY', 's-KE'].includes(e.subjectId) || e.gradeLevel > 6),
      ...spread('s-NO', 432, [4, 5, 6]),
    ];
    const whole = check(B1, 300, subjects, integrated);
    expect(whole.verdicts).toEqual([]);
    expect(cell(whole, 'NO', 'MELLAN').children?.map((c) => c.plannedHours)).toEqual([0, 0, 0]);
  });

  it('puts hem- och konsumentkunskap from åk 2 and åk 5 in the one låg- och mellanstadiet cell', () => {
    const { subjects, entries } = compliantPlan(B1, 300);
    // 40 h = 80 min/vecka in all; the plan says 20 in åk 2 and 60 in åk 5.
    const hkk = [
      ...entries.filter((e) => !(e.subjectId === 's-HKK' && e.gradeLevel <= 6)),
      { subjectId: 's-HKK', gradeLevel: 2, minutesPerWeek: 20 },
      { subjectId: 's-HKK', gradeLevel: 5, minutesPerWeek: 60 },
    ];
    const result = check(B1, 300, subjects, hkk);
    expect(cell(result, 'HKK', 'LAG_MELLAN')).toMatchObject({ nationalHours: 40, plannedHours: 40 });
    expect(result.cells.some((c) => c.subjectCode === 'HKK' && (c.stage === 'LAG' || c.stage === 'MELLAN'))).toBe(false);
    expect(cell(result, 'HKK', 'HOG').nationalHours).toBe(90);
    expect(result.verdicts).toEqual([]);
  });

  it('treats språkval in åk 3, where the bilaga has no cell, as the school’s own time', () => {
    const { subjects, entries } = compliantPlan(B1, 300);
    const result = check(B1, 300, subjects, [...entries, { subjectId: 's-M2', gradeLevel: 3, minutesPerWeek: 40 }]);
    expect(cell(result, 'M2', 'LAG')).toMatchObject({ nationalHours: 0, plannedHours: 20, surplusHours: 20, deficitHours: 0 });
    expect(result.skolansVal.placedHours).toBe(20);
    expect(result.verdicts).toEqual([]);
  });

  it('leaves out a subject that is not undervisning, and reports förskoleklass outside every stage', () => {
    const { subjects, entries } = compliantPlan(B1, 300);
    const mentorstid: CoverageSubject = { id: 's-MENT', name: 'Mentorstid', nationalCode: null, countsTowardTimplan: false };
    const resurs: CoverageSubject = coded('MA', { id: 's-RES', name: 'Resurs matematik', countsTowardTimplan: false });
    const base = check(B1, 300, subjects, entries);
    const result = check(B1, 300, [...subjects, mentorstid, resurs], [
      ...entries,
      ...spread(mentorstid.id, 540, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
      ...spread(resurs.id, 300, [7, 8, 9]),
      { subjectId: 's-MA', gradeLevel: 0, minutesPerWeek: 60 },
    ]);
    expect(result.verdicts).toEqual([]);
    expect(result.unmapped).toEqual([]);
    expect(result.total).toEqual(base.total);
    expect(cell(result, 'MA', 'HOG')).toEqual(cell(base, 'MA', 'HOG'));
    expect(result.gradesOutsideStages).toEqual([0]);
  });

  it('orders the verdicts: unmapped first, then by severity of rule, stage and code', () => {
    const { subjects, entries } = compliantPlan(B1, 300);
    const prog: CoverageSubject = { id: 's-PROG', name: 'Programmering', nationalCode: null, countsTowardTimplan: true };
    let plan = replaceStage(entries, 's-MA', [7, 8, 9], [266, 266, 266]);
    plan = replaceStage(plan, 's-BL', [1, 2, 3], [30, 30, 30]);
    plan = [...plan, ...spread(prog.id, 30, [4, 5, 6])];
    const result = check(B1, 300, [...subjects, prog], plan);
    expect(codes(result)).toEqual([
      'TIMPLAN_SUBJECT_UNMAPPED',
      'TIMPLAN_PROTECTED_SUBJECT_REDUCED',
      'TIMPLAN_REDUCTION_OVER_CAP',
      'TIMPLAN_TOTAL_BELOW_GUARANTEE',
    ]);
  });
});

describe('checkLocalTimplan — the other bilagor', () => {
  it('sameskolan: a 15 % cap, samiska protected, and åk 7 outside every stage', () => {
    const { subjects, entries } = compliantPlan(B4, 300);
    expect(check(B4, 300, subjects, entries).verdicts).toEqual([]);

    // Bild lågstadiet 60 h: 51 h is 15 % exactly, 50.5 h is past it.
    const atCap = check(B4, 300, subjects, replaceStage(entries, 's-BL', [1, 2, 3], [34, 34, 34]));
    expect(atCap.verdicts[0]).toMatchObject({ code: 'TIMPLAN_STAGE_BELOW_NATIONAL', params: { reducedPercent: 15 } });
    const overCap = check(B4, 300, subjects, replaceStage(entries, 's-BL', [1, 2, 3], [34, 34, 33]));
    expect(overCap.verdicts[0]).toMatchObject({
      code: 'TIMPLAN_REDUCTION_OVER_CAP',
      params: { capPercent: 15, reducedPercent: 15.9 },
    });

    const sam = entries.filter((e) => e.subjectId === 's-SAM' && e.gradeLevel <= 3);
    const samiska = check(B4, 300, subjects, [
      ...entries.filter((e) => !sam.includes(e)),
      ...sam.map((e, i) => ({ ...e, minutesPerWeek: e.minutesPerWeek - (i === 0 ? 1 : 0) })),
      { subjectId: 's-MA', gradeLevel: 7, minutesPerWeek: 120 },
    ]);
    expect(samiska.verdicts[0]).toMatchObject({ code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED', subjectCode: 'SAM' });
    expect(samiska.gradesOutsideStages).toEqual([7]);
    expect(samiska.total.guaranteedHours).toBe(4473);
  });

  it('specialskolan: matematik lågstadiet runs åk 1–4, and åk 10 is högstadiet', () => {
    const { subjects, entries } = compliantPlan(B3, 356);
    const result = check(B3, 356, subjects, entries);
    expect(result.verdicts).toEqual([]);
    expect(cell(result, 'MA', 'LAG').nationalHours).toBe(560);
    expect(entries.filter((e) => e.subjectId === 's-MA').map((e) => e.gradeLevel).sort((a, b) => a - b)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    // Take åk 10's matematik away and högstadiet is short, not lågstadiet.
    const no10 = check(B3, 356, subjects, entries.filter((e) => !(e.subjectId === 's-MA' && e.gradeLevel === 10)));
    expect(no10.verdicts[0]).toMatchObject({ code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED', subjectCode: 'MA', stage: 'HOG' });
  });

  it('anpassade grundskolan: no cap and no protected subject, so a deep cut is below mål and nothing more', () => {
    const { subjects, entries } = compliantPlan(B2A, 300);
    const cut = check(B2A, 300, subjects, replaceStage(entries, 's-MA', [1, 2, 3], [200, 200, 200]));
    expect(cut.verdicts[0]).toMatchObject({
      code: 'TIMPLAN_STAGE_BELOW_NATIONAL',
      severity: 'notice',
      subjectCode: 'MA',
      params: { nationalHours: 400, plannedHours: 300, reducedPercent: 25 },
    });
    expect(codes(cut)).not.toContain('TIMPLAN_REDUCTION_OVER_CAP');
    // Ämnesområden prints no skolans val, so the pool is never overspent.
    const omraden = compliantPlan(B2B, 300);
    const deep = check(B2B, 300, omraden.subjects, replaceStage(omraden.entries, 's-KOM', [1, 2, 3], [0, 0, 0]));
    expect(deep.skolansVal.availableHours).toBeNull();
    expect(codes(deep)).toEqual(['TIMPLAN_STAGE_BELOW_NATIONAL', 'TIMPLAN_TOTAL_BELOW_GUARANTEE']);
  });

  it('the 2028 law: "fördelning ej publicerad", never zero hours in every cell', () => {
    const { subjects, entries } = compliantPlan(B1, 356);
    const result = check(LAW_2028, 356, subjects, entries);
    expect(result.distributionPublished).toBe(false);
    expect(result.verdicts[0]).toEqual({
      code: 'TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED',
      severity: 'notice',
      params: { versionCode: LAW_2028, totalHours: 7424 },
    });
    // No cell is "below" a figure that does not exist.
    expect(result.cells.every((c) => c.nationalHours === 0 && c.deficitHours === 0)).toBe(true);
    expect(codes(result)).not.toContain('TIMPLAN_STAGE_BELOW_NATIONAL');
    expect(codes(result)).not.toContain('TIMPLAN_PROTECTED_SUBJECT_REDUCED');
    expect(result.skolansVal).toEqual({ availableHours: null, takenHours: 0, placedHours: 0 });
    // The total is law already, and a nine-year plan is short of it.
    expect(result.total.guaranteedHours).toBe(7424);
    expect(codes(result)).toContain('TIMPLAN_TOTAL_BELOW_GUARANTEE');
    expect(result.stageGrades.LAG).toEqual([1, 2, 3, 4]);
  });
});

describe('checkLocalTimplan — the input it refuses', () => {
  it('will not compute with weeks it cannot hold as an integer of tenths', () => {
    const base = { version: version(B1), nationalSubjects: STATUTE.subjects, subjects: [], entries: [] };
    expect(() => checkLocalTimplan({ ...base, planningWeeksTenths: 35.6 })).toThrow();
    expect(() => checkLocalTimplan({ ...base, planningWeeksTenths: 0 })).toThrow();
    expect(() =>
      checkLocalTimplan({ ...base, planningWeeksTenths: undefined as unknown as number }),
    ).toThrow();
  });

  it('ignores an entry whose subject it was not given, rather than inventing one', () => {
    const result = checkLocalTimplan({
      planningWeeksTenths: 356,
      version: version(B1),
      nationalSubjects: STATUTE.subjects,
      subjects: [],
      entries: [{ subjectId: 'gone', gradeLevel: 4, minutesPerWeek: 180 }],
    });
    expect(result.total.plannedHours).toBe(0);
    expect(result.unmapped).toEqual([]);
  });
});
