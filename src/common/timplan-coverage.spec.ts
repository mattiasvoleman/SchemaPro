import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import {
  assertGradeSpan,
  checkLocalTimplan,
  heldStageGrades,
  inGradeSpan,
  planningWeeksInTenths,
  stageGradesFor,
  type CoverageEntry,
  type CoverageNationalSubject,
  type CoverageSubject,
  type CoverageVersion,
  type GradeSpan,
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

  it('gives specialskolan eleven årskurser in the 2028 law: 1–5 / 6–8 / 9–11 (12 kap. 3 §)', () => {
    // SFS2025:729/SPE (20261126090000), a row of P0's form with no cells.
    expect(stageGradesFor({ schoolForm: 'SPECIALSKOLA', appliesFromCohortTerm: 'HT2028' })).toEqual({
      LAG: [1, 2, 3, 4, 5],
      MELLAN: [6, 7, 8],
      HOG: [9, 10, 11],
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

    // One minute a week less in åk 3: 707 × 35.6 = 25 169.2 min = 419.49 h,
    // shown as 419,4 so that it and the 0,6 h deficit make the 420.
    const short = check(B1, 356, subjects, replaceStage(entries, 's-MA', [1, 2, 3], [236, 236, 235]));
    expect(cell(short, 'MA', 'LAG')).toMatchObject({
      plannedHours: 419.4,
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
        params: { nationalHours: 420, plannedHours: 419.4, deficitHours: 0.6, reducedPercent: 0.2 },
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

  it('takes Svenska and SvA as the alternatives they are: the cell is the longer of the two, per årskurs', () => {
    // "Svenska eller svenska som andraspråk": a pupil reads one. Both planned
    // at full length used to add up to 1 360 h of lågstadiesvenska and lift the
    // plan's total past a guarantee it was short of.
    const { subjects, entries } = compliantPlan(B1, 300);
    const sva: CoverageSubject = coded('SV_SVA', { id: 's-SVA', name: 'Svenska som andraspråk' });
    const svaEntries = entries
      .filter((e) => e.subjectId === 's-SV_SVA')
      .map((e) => ({ ...e, subjectId: sva.id }));
    const alone = check(B1, 300, subjects, entries);
    const both = check(B1, 300, [...subjects, sva], [...entries, ...svaEntries]);
    expect(cell(both, 'SV_SVA', 'LAG')).toMatchObject({
      plannedHours: cell(alone, 'SV_SVA', 'LAG').plannedHours,
      subjectIds: ['s-SVA', 's-SV_SVA'],
    });
    expect(both.total.plannedHours).toBe(alone.total.plannedHours);
    expect(both.skolansVal.placedHours).toBe(alone.skolansVal.placedHours);
    expect(both.verdicts).toEqual([]);

    // An SvA group shorter than Svenska leaves the cell at Svenska's minutes:
    // the plan offers the time; who reads which is the per-pupil check (P2).
    const short = check(B1, 300, [...subjects, sva], [...entries, ...spread(sva.id, 160, [1, 2, 3])]);
    expect(cell(short, 'SV_SVA', 'LAG').plannedHours).toBe(cell(alone, 'SV_SVA', 'LAG').plannedHours);

    // A forgotten SvA mapping is named first, and its hours are the school's own.
    const forgotten = check(B1, 300, [...subjects, { ...sva, nationalCode: null }], [...entries, ...spread(sva.id, 160, [1, 2, 3])]);
    expect(codes(forgotten)).toEqual(['TIMPLAN_SUBJECT_UNMAPPED']);
    expect(forgotten.verdicts[0]).toMatchObject({
      severity: 'notice',
      params: { subjectId: 's-SVA', subjectName: 'Svenska som andraspråk', plannedHours: 80, timeCountsAs: 'skolansVal' },
    });
    expect(forgotten.skolansVal.placedHours).toBe(alone.skolansVal.placedHours + 80);
  });

  it('takes språkval languages as alternatives: three languages short of the cell are short, not three times over', () => {
    // A pupil reads ONE språkval. Spanska, Tyska and Franska at 30 min in åk 6
    // and 60 in åk 7–9 give each pupil 17,8 h of 48 and 106,8 h of 272 — the
    // sum (53,4 h and 320,4 h) used to report both cells met and the plan
    // without a single verdict.
    const { subjects, entries } = compliantPlan(B1, 356);
    const languages = ['Spanska', 'Tyska', 'Franska'].map((name) =>
      coded('M2', { id: `s-${name}`, name }),
    );
    const others = subjects.filter((s) => s.id !== 's-M2');
    const rest = entries.filter((e) => e.subjectId !== 's-M2');
    const taught = (subject: CoverageSubject) => [
      { subjectId: subject.id, gradeLevel: 6, minutesPerWeek: 30 },
      ...[7, 8, 9].map((gradeLevel) => ({ subjectId: subject.id, gradeLevel, minutesPerWeek: 60 })),
    ];

    const three = check(B1, 356, [...others, ...languages], [...rest, ...languages.flatMap(taught)]);
    const one = check(B1, 356, [...others, languages[0]!], [...rest, ...taught(languages[0]!)]);

    expect(cell(three, 'M2', 'MELLAN')).toMatchObject({ nationalHours: 48, plannedHours: 17.8 });
    expect(cell(three, 'M2', 'HOG')).toMatchObject({ nationalHours: 272, plannedHours: 106.8 });
    expect(codes(three)).toEqual(codes(one));
    expect(three.verdicts.filter((v) => v.subjectCode === 'M2')).toEqual([
      expect.objectContaining({ code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED', stage: 'MELLAN' }),
      expect.objectContaining({ code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED', stage: 'HOG' }),
    ]);
    expect(three.total.plannedHours).toBe(one.total.plannedHours);
    expect(cell(three, 'M2', 'HOG').subjectIds).toEqual(['s-Franska', 's-Spanska', 's-Tyska']);
  });

  it('never shows a cell as met in its figures while calling it short: planned + deficit is the target', () => {
    // 231 + 230 + 230 min of matematik over 35.6 weeks is 409,99 h: four
    // minute-tenths short of 410. Rounded to nearest it read "410 h planerat,
    // 0,1 h under målet 410 h".
    const { subjects, entries } = compliantPlan(B1, 356);
    const result = check(B1, 356, subjects, replaceStage(entries, 's-MA', [4, 5, 6], [231, 230, 230]));
    expect(cell(result, 'MA', 'MELLAN')).toMatchObject({ plannedHours: 409.9, deficitHours: 0.1 });
    expect(result.verdicts.find((v) => v.subjectCode === 'MA')?.params).toMatchObject({
      nationalHours: 410,
      plannedHours: 409.9,
      deficitHours: 0.1,
    });

    // The total likewise, when it is below the guarantee.
    const empty = check(B1, 356, subjects, replaceStage(entries, 's-MA', [4, 5, 6], [0, 0, 0]));
    const total = empty.verdicts.find((v) => v.code === 'TIMPLAN_TOTAL_BELOW_GUARANTEE')!;
    expect(Number(total.params.plannedHours) + Number(total.params.deficitHours)).toBeCloseTo(6890, 5);
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
        params: { nationalHours: 60, plannedHours: 48, deficitHours: 12, reducedPercent: 20, timeCountsAs: 'skolansVal' },
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

  it('says what reduced and uncoded time counts as by the bilaga: skolans val only where one is printed', () => {
    // Bilaga 1 prints skolans val: a cell under mål and an uncoded subject are
    // that pool's time.
    const grund = compliantPlan(B1, 300);
    const own = coded('PROG', { id: 's-PROG', name: 'Programmering', nationalCode: null });
    const bild = grund.entries.filter((e) => e.subjectId === 's-BL' && [1, 2, 3].includes(e.gradeLevel));
    const b1 = check(B1, 300, [...grund.subjects, own], [
      ...replaceStage(grund.entries, 's-BL', [1, 2, 3], bild.map((e, i) => e.minutesPerWeek - (i === 0 ? 5 : 0))),
      { subjectId: own.id, gradeLevel: 2, minutesPerWeek: 60 },
    ]);
    expect(b1.verdicts.find((v) => v.code === 'TIMPLAN_SUBJECT_UNMAPPED')?.params.timeCountsAs).toBe('skolansVal');
    expect(b1.verdicts.find((v) => v.code === 'TIMPLAN_STAGE_BELOW_NATIONAL')?.params.timeCountsAs).toBe('skolansVal');

    // Ämnesområden prints none; its free time is the cell "Fördelningsbar
    // undervisningstid", which an uncoded subject is pointed to.
    const omraden = compliantPlan(B2B, 300);
    const b2b = check(B2B, 300, [...omraden.subjects, own], [
      ...replaceStage(omraden.entries, 's-KOM', [1, 2, 3], [100, 100, 100]),
      { subjectId: own.id, gradeLevel: 2, minutesPerWeek: 60 },
    ]);
    expect(b2b.verdicts.find((v) => v.code === 'TIMPLAN_SUBJECT_UNMAPPED')?.params.timeCountsAs).toBe('fordelningsbar');
    expect(b2b.verdicts.find((v) => v.code === 'TIMPLAN_STAGE_BELOW_NATIONAL')?.params.timeCountsAs).toBe('none');

    // The 2028 law states neither yet.
    const law = check(LAW_2028, 300, [...grund.subjects, own], [...grund.entries, { subjectId: own.id, gradeLevel: 2, minutesPerWeek: 60 }]);
    expect(law.verdicts.find((v) => v.code === 'TIMPLAN_SUBJECT_UNMAPPED')?.params.timeCountsAs).toBe('own');
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

/*
 * The plan's årskurs span. The figures below are counted by hand from the
 * bilaga, not read back from the module:
 *
 *   B1 lågstadiet's top-level cells sum to 1 882 h, mellanstadiet's to 2 334 h,
 *   högstadiet's to 2 634 h, and hem- och konsumentkunskap's merged låg- och
 *   mellanstadium cell is 40 h (+ 90 h in högstadiet, inside the 2 634): 6 890.
 *
 *   4–9   holds mellanstadiet, högstadiet and 3/6 of the merged cell:
 *         6 890 − 1 882 − 20 = 4 988 h; pool 600 × 4 988 / 6 890 = 434,4 h.
 *   F–5   holds lågstadiet, 2/3 of mellanstadiet (1 556 h), 5/6 of the merged
 *         cell: 1 882 + 1 556 + 33⅓ = 3 471,3 h; pool 302,3 h.
 *   6–9   holds 1/3 of mellanstadiet (778 h), 1/6 of the merged cell and
 *         högstadiet: 778 + 6⅔ + 2 634 = 3 418,7 h; pool 297,7 h.
 */
describe('checkLocalTimplan — the plan’s årskurs span', () => {
  const FROM_4_TO_9: GradeSpan = { gradeFrom: 4, gradeTo: 9 };
  const FROM_F_TO_5: GradeSpan = { gradeFrom: 0, gradeTo: 5 };
  const FROM_6_TO_9: GradeSpan = { gradeFrom: 6, gradeTo: 9 };

  /**
   * A plan that meets the bilaga for the årskurser `span` holds: every cell's
   * minutes a week divided over ALL the årskurser of its stadium and given to
   * each held one, so a partly held stadium is met to exactly its share.
   */
  function spanPlan(code: string, weeksTenths: number, span: GradeSpan) {
    const v = version(code);
    const held = (grade: number) => grade >= span.gradeFrom && grade <= span.gradeTo;
    const subjects = new Map<string, CoverageSubject>();
    const entries: CoverageEntry[] = [];
    const plan = (nationalCode: string, hours: number, stage: TimplanStage) => {
      subjects.set(nationalCode, subjects.get(nationalCode) ?? coded(nationalCode));
      const grades = gradesOf(v, stage);
      const perGrade = Math.ceil(minutesFor(hours, weeksTenths) / grades.length);
      for (const gradeLevel of grades.filter(held)) {
        entries.push({ subjectId: `s-${nationalCode}`, gradeLevel, minutesPerWeek: perGrade });
      }
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
      for (const child of children) plan(child.subjectCode, child.hours + free / children.length, cell.stage);
    }
    return { subjects: [...subjects.values()], entries };
  }

  const withSpan = (
    code: string,
    weeksTenths: number,
    plan: { subjects: CoverageSubject[]; entries: CoverageEntry[] },
    gradeSpan: GradeSpan | null | undefined,
  ): TimplanCheck =>
    checkLocalTimplan({
      planningWeeksTenths: weeksTenths,
      version: version(code),
      nationalSubjects: STATUTE.subjects,
      subjects: plan.subjects,
      entries: plan.entries,
      gradeSpan,
    });

  /** The plan's minutes in `grades` for one subject, replaced. */
  const setMinutes = (entries: CoverageEntry[], code: string, grades: number[], minutes: number) =>
    entries.map((e) => (e.subjectId === `s-${code}` && grades.includes(e.gradeLevel) ? { ...e, minutesPerWeek: minutes } : e));

  const stagesOf = (result: TimplanCheck) => [...new Set(result.cells.map((c) => c.stage))].sort();

  /** Time the school moves elsewhere (an uncoded subject, skolans val placed), so a cut cell does not also leave the total short. */
  const placedElsewhere = (plan: { subjects: CoverageSubject[]; entries: CoverageEntry[] }) => ({
    subjects: [...plan.subjects, { id: 's-PROG', name: 'Programmering', nationalCode: null, countsTowardTimplan: true }],
    entries: [
      ...plan.entries,
      ...[1, 2, 3, 4, 5].map((gradeLevel) => ({ subjectId: 's-PROG', gradeLevel, minutesPerWeek: 150 })),
    ],
  });

  describe('no span, or a span of the whole form, is the check of before', () => {
    it('treats an absent, an undefined and a null span alike, and adds nothing to the document', () => {
      const plan = compliantPlan(B1, 356);
      const bare = check(B1, 356, plan.subjects, plan.entries);
      expect(withSpan(B1, 356, plan, null)).toEqual(bare);
      expect(withSpan(B1, 356, plan, undefined)).toEqual(bare);
      expect(Object.keys(bare)).not.toContain('gradeSpan');
      expect(Object.keys(bare.total)).not.toContain('judged');
      expect(bare.cells.some((c) => 'share' in c)).toBe(false);
    });

    it.each([
      ['0–9', 0, 9],
      ['1–9', 1, 9],
      ['1–11', 1, 11],
    ])('reads a span %s that holds every årskurs of grundskolan as no span: the same numbers, partial false', (_label, gradeFrom, gradeTo) => {
      const plan = spanPlan(B1, 356, { gradeFrom: 1, gradeTo: 9 });
      const whole = withSpan(B1, 356, plan, { gradeFrom, gradeTo });
      const none = withSpan(B1, 356, plan, null);
      expect(whole.gradeSpan).toEqual({ gradeFrom, gradeTo, partial: false });
      expect({ ...whole, gradeSpan: undefined }).toEqual(none);
      expect(whole.total.guaranteedHours).toBe(6890);
      expect(whole.skolansVal.availableHours).toBe(600);
    });

    it('judges the same short plan the same way with and without a whole span', () => {
      const { subjects, entries } = compliantPlan(B1, 356);
      const short = setMinutes(entries, 'MA', [1, 2, 3], 100);
      const none = withSpan(B1, 356, { subjects, entries: short }, null);
      const whole = withSpan(B1, 356, { subjects, entries: short }, { gradeFrom: 0, gradeTo: 9 });
      expect(codes(none)).toContain('TIMPLAN_PROTECTED_SUBJECT_REDUCED');
      expect({ ...whole, gradeSpan: undefined }).toEqual(none);
    });
  });

  describe('the three schools of the report', () => {
    it('a correct 4–9 plan has no verdict: lågstadiet is not judged, 4 988 h guaranteed, 434,4 h of skolans val', () => {
      const result = withSpan(B1, 356, spanPlan(B1, 356, FROM_4_TO_9), FROM_4_TO_9);
      expect(result.verdicts).toEqual([]);
      expect(result.total).toMatchObject({ guaranteedHours: 4988, deficitHours: 0 });
      expect(result.skolansVal).toMatchObject({ availableHours: 434.4, takenHours: 0 });
      expect(result.gradeSpan).toEqual({ gradeFrom: 4, gradeTo: 9, partial: true });
      // The stadium it lacks has no cell at all, not a cell with zero planned.
      expect(stagesOf(result)).toEqual(['HOG', 'LAG_MELLAN', 'MELLAN']);
      expect(result.cells.filter((c) => c.subjectCode === 'NO').map((c) => c.stage).sort()).toEqual(['HOG', 'MELLAN']);
      expect(result.cells.some((c) => c.subjectCode === 'BI' && c.stage === 'LAG')).toBe(false);
    });

    it('a correct F–5 plan has no verdict: lågstadiet whole, mellanstadiet two thirds, 3 471,3 h and 302,3 h', () => {
      const result = withSpan(B1, 356, spanPlan(B1, 356, FROM_F_TO_5), FROM_F_TO_5);
      expect(result.verdicts).toEqual([]);
      expect(result.total.guaranteedHours).toBe(3471.3);
      expect(result.skolansVal.availableHours).toBe(302.3);
      expect(stagesOf(result)).toEqual(['LAG', 'LAG_MELLAN', 'MELLAN']);
      expect(result.cells.some((c) => c.stage === 'HOG')).toBe(false);
    });

    it('a correct 6–9 plan has no verdict: mellanstadiet one third, 3 418,7 h and 297,7 h', () => {
      const result = withSpan(B1, 356, spanPlan(B1, 356, FROM_6_TO_9), FROM_6_TO_9);
      expect(result.verdicts).toEqual([]);
      expect(result.total.guaranteedHours).toBe(3418.7);
      expect(result.skolansVal.availableHours).toBe(297.7);
      expect(result.cells.some((c) => c.stage === 'LAG')).toBe(false);
    });

    it('the same 4–9 plan without its span is the 12 warnings the report began with', () => {
      // The report's plan puts the whole of hem- och konsumentkunskap's 40 h in åk 4–6.
      const base = spanPlan(B1, 356, FROM_4_TO_9);
      const plan = { ...base, entries: setMinutes(base.entries, 'HKK', [4, 5, 6], 24) };
      const result = withSpan(B1, 356, plan, null);
      expect(result.verdicts.filter((v) => v.severity === 'warning')).toHaveLength(12);
      expect(result.skolansVal.takenHours).toBe(1882); // lågstadiet, all of it, "taken" from a pool of 600
      expect(result.total.deficitHours).toBeGreaterThan(1800);
    });
  });

  describe('a stadium held in part is judged by its share, and only as a notice', () => {
    it('cuts a cell to held årskurser over the stadium’s, and says so on the cell', () => {
      const result = withSpan(B1, 356, spanPlan(B1, 356, FROM_F_TO_5), FROM_F_TO_5);
      const ma = cell(result, 'MA', 'MELLAN');
      expect(ma.share).toEqual({ held: 2, of: 3 });
      expect(ma.nationalHours).toBe(273.3); // 410 × 2/3
      expect(cell(result, 'MA', 'LAG').share).toBeUndefined();
      expect(cell(result, 'MA', 'LAG').nationalHours).toBe(420);
      expect(cell(result, 'HKK', 'LAG_MELLAN')).toMatchObject({ share: { held: 5, of: 6 }, nationalHours: 33.3 });
      const six = withSpan(B1, 356, spanPlan(B1, 356, FROM_6_TO_9), FROM_6_TO_9);
      expect(cell(six, 'MA', 'MELLAN')).toMatchObject({ share: { held: 1, of: 3 }, nationalHours: 136.7 });
      expect(cell(six, 'MA', 'HOG').share).toBeUndefined();
    });

    it('a protected subject under its share is a notice, not PROTECTED_SUBJECT_REDUCED', () => {
      const plan = placedElsewhere(spanPlan(B1, 356, FROM_F_TO_5));
      const result = withSpan(B1, 356, { ...plan, entries: setMinutes(plan.entries, 'MA', [4, 5], 100) }, FROM_F_TO_5);
      const verdict = result.verdicts.find((v) => v.subjectCode === 'MA')!;
      expect(verdict).toMatchObject({
        code: 'TIMPLAN_PARTIAL_STAGE_BELOW_SHARE',
        severity: 'notice',
        stage: 'MELLAN',
        // 2 × 100 min × 35.6 weeks = 118,7 h (down) of the share 273,3 h
        params: { nationalHours: 273.3, plannedHours: 118.6, deficitHours: 154.7, heldGrades: 2, ofGrades: 3 },
      });
      expect(codes(result)).not.toContain('TIMPLAN_PROTECTED_SUBJECT_REDUCED');
      expect(result.verdicts.filter((v) => v.severity === 'warning')).toEqual([]);
    });

    it('still holds the total to the guarantee: time cut from a partly held cell and placed nowhere is a warning there', () => {
      const plan = spanPlan(B1, 356, FROM_F_TO_5);
      const result = withSpan(B1, 356, { ...plan, entries: setMinutes(plan.entries, 'MA', [4, 5], 100) }, FROM_F_TO_5);
      expect(codes(result)).toEqual(['TIMPLAN_PARTIAL_STAGE_BELOW_SHARE', 'TIMPLAN_TOTAL_BELOW_GUARANTEE']);
    });

    it('shows a short share as the sum of what it shows: planned + deficit is the target, to the tenth', () => {
      // Nothing planned in åk 4–5 of F–5: the share of HKK's 40 h over six årskurser is 33⅓ h
      // for five of them, and "0 h planerat, 33,4 h under andelen 33,3 h" does not add up.
      const result = withSpan(B1, 356, { subjects: [coded('HKK')], entries: [] }, FROM_F_TO_5);
      const hkk = result.verdicts.find((v) => v.subjectCode === 'HKK')!;
      expect(hkk.params).toMatchObject({ plannedHours: 0, deficitHours: 33.4, nationalHours: 33.4, heldGrades: 5, ofGrades: 6 });
      expect(cell(result, 'HKK', 'LAG_MELLAN').nationalHours).toBe(33.4);
      // The guarantee of the cells held is shown the same way: nothing planned, 3 471⅓ h short.
      expect(result.total).toMatchObject({ plannedHours: 0, guaranteedHours: 3471.4, deficitHours: 3471.4 });
      for (const verdict of result.verdicts.filter((v) => v.code === 'TIMPLAN_PARTIAL_STAGE_BELOW_SHARE')) {
        const { plannedHours, deficitHours, nationalHours } = verdict.params as Record<string, number>;
        expect(Math.round((plannedHours! + deficitHours!) * 10) / 10).toBe(nationalHours);
      }
      // A share that is met is shown to the nearest tenth, as ever.
      const met = withSpan(B1, 356, spanPlan(B1, 356, FROM_F_TO_5), FROM_F_TO_5);
      expect(cell(met, 'HKK', 'LAG_MELLAN').nationalHours).toBe(33.3);
    });

    it('a cell cut past the cap is a notice too, in a partly held stadium', () => {
      const plan = placedElsewhere(spanPlan(B1, 356, FROM_F_TO_5));
      const cut = { ...plan, entries: setMinutes(plan.entries, 'BL', [4, 5], 20) };
      const partly = withSpan(B1, 356, cut, FROM_F_TO_5);
      const notUnmapped = (result: TimplanCheck) => codes(result).filter((code) => code !== 'TIMPLAN_SUBJECT_UNMAPPED');
      expect(notUnmapped(partly)).toEqual(['TIMPLAN_PARTIAL_STAGE_BELOW_SHARE']);
      // The same cut to lågstadiet, which F–5 holds whole, is past the cap.
      const whole = withSpan(B1, 356, { ...plan, entries: setMinutes(plan.entries, 'BL', [1, 2, 3], 10) }, FROM_F_TO_5);
      expect(notUnmapped(whole)).toEqual(['TIMPLAN_REDUCTION_OVER_CAP']);
    });

    it('a stadium the span holds whole is judged as ever: a protected subject reduced is a warning', () => {
      const plan = spanPlan(B1, 356, FROM_4_TO_9);
      const result = withSpan(B1, 356, { ...plan, entries: setMinutes(plan.entries, 'MA', [7, 8, 9], 100) }, FROM_4_TO_9);
      expect(result.verdicts[0]).toMatchObject({ code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED', severity: 'warning', stage: 'HOG' });
    });

    it('judges a per-child minimum against its share, as a notice naming the child', () => {
      // KE needs 60 h in mellanstadiet; two of three årskurser need 40.
      const plan = spanPlan(B1, 356, FROM_F_TO_5);
      const result = withSpan(B1, 356, { ...plan, entries: setMinutes(plan.entries, 'KE', [4, 5], 25) }, FROM_F_TO_5);
      const ke = result.verdicts.find((v) => v.childCode === 'KE')!;
      expect(ke).toMatchObject({
        code: 'TIMPLAN_PARTIAL_STAGE_BELOW_SHARE',
        severity: 'notice',
        subjectCode: 'NO',
        params: { childCode: 'KE', minimumHours: 40, heldGrades: 2, ofGrades: 3 },
      });
      expect(codes(result)).not.toContain('TIMPLAN_GROUP_MINIMUM_UNMET');
      expect(cell(result, 'NO', 'MELLAN').children!.find((c) => c.subjectCode === 'KE')!.minimumHours).toBe(40);
      // 25 min is under 60/3 × 2 = 40 h of the whole stadium too: a full stadium warns.
      const whole = withSpan(B1, 356, { ...plan, entries: setMinutes(plan.entries, 'KE', [1, 2, 3], 5) }, FROM_F_TO_5);
      expect(codes(whole)).not.toContain('TIMPLAN_GROUP_MINIMUM_UNMET'); // KE is only judged where the plan names a child
    });

    it('cuts the merged cell over every årskurs it spans, an uneven seven in specialskolan', () => {
      const span: GradeSpan = { gradeFrom: 5, gradeTo: 10 };
      const plan = spanPlan(B3, 356, span);
      const met = withSpan(B3, 356, plan, span);
      expect(met.verdicts).toEqual([]);
      expect(cell(met, 'HKK', 'LAG_MELLAN')).toMatchObject({ share: { held: 3, of: 7 }, nationalHours: 21.4 }); // 50 × 3/7
      const low = withSpan(B3, 356, { ...plan, entries: setMinutes(plan.entries, 'HKK', [5, 6, 7], 8) }, span);
      expect(low.verdicts).toHaveLength(1);
      expect(low.verdicts[0]).toMatchObject({
        code: 'TIMPLAN_PARTIAL_STAGE_BELOW_SHARE',
        stage: 'LAG_MELLAN',
        params: { heldGrades: 3, ofGrades: 7 },
      });
    });
  });

  describe('the guarantee and the pool of skolans val', () => {
    it('sums the cells the plan holds, the shared ones scaled, and scales the pool by the same fraction', () => {
      for (const [span, guaranteed, pool] of [
        [FROM_4_TO_9, 4988, 434.4],
        [FROM_F_TO_5, 3471.3, 302.3],
        [FROM_6_TO_9, 3418.7, 297.7],
      ] as const) {
        const result = withSpan(B1, 356, spanPlan(B1, 356, span), span);
        expect([result.total.guaranteedHours, result.skolansVal.availableHours]).toEqual([guaranteed, pool]);
      }
    });

    it('counts a shortfall against a partly held cell as taken from the pool', () => {
      // MA 4–5 at 100 min: 273,3 − 118,7 = 154,7 h; BL 4–5 at 20 min: 53,3 − 23,7 = 29,6 h.
      const plan = spanPlan(B1, 356, FROM_F_TO_5);
      const entries = setMinutes(setMinutes(plan.entries, 'MA', [4, 5], 100), 'BL', [4, 5], 20);
      expect(withSpan(B1, 356, { ...plan, entries }, FROM_F_TO_5).skolansVal.takenHours).toBe(184.3);
    });

    it('warns that the pool is overspent, and calls its figure an estimate only for a span', () => {
      const plan = spanPlan(B1, 356, FROM_F_TO_5);
      // MA and Svenska not given at all in 4–5: 273,3 + 346,7 = 620 h of a 302,3 h pool.
      const entries = setMinutes(setMinutes(plan.entries, 'MA', [4, 5], 0), 'SV_SVA', [4, 5], 0);
      const result = withSpan(B1, 356, { ...plan, entries }, FROM_F_TO_5);
      const overspent = result.verdicts.find((v) => v.code === 'TIMPLAN_SKOLANS_VAL_OVERSPENT')!;
      expect(overspent).toMatchObject({
        severity: 'warning',
        params: { takenHours: 620, availableHours: 302.3, overspentHours: 317.7, estimated: 1 },
      });
      const whole = withSpan(B1, 356, { ...plan, entries: setMinutes(plan.entries, 'MA', [1, 2, 3], 0) }, null);
      expect(whole.verdicts.find((v) => v.code === 'TIMPLAN_SKOLANS_VAL_OVERSPENT')!.params).not.toHaveProperty('estimated');
    });

    it('holds the total to the guarantee of the cells held, marked as an estimate', () => {
      const plan = spanPlan(B1, 356, FROM_4_TO_9);
      const result = withSpan(B1, 356, { ...plan, entries: setMinutes(plan.entries, 'MA', [7, 8, 9], 100) }, FROM_4_TO_9);
      const total = result.verdicts.find((v) => v.code === 'TIMPLAN_TOTAL_BELOW_GUARANTEE')!;
      expect(total.params).toMatchObject({ guaranteedHours: 4988, estimated: 1 });
      expect(total.params.deficitHours).toBe(result.total.deficitHours);
      expect(result.total.deficitHours).toBeGreaterThan(0);
    });

    it('does not judge a span-less lydelse’s total for part of the form, and says so in a notice', () => {
      // SFS 2025:729 prints 7 424 h and no cells; åk 5–10 is part of 1–10.
      const subjects = [coded('MA')];
      const entries = [5, 6, 7, 8, 9, 10].map((gradeLevel) => ({ subjectId: 's-MA', gradeLevel, minutesPerWeek: 180 }));
      const part = withSpan(LAW_2028, 356, { subjects, entries }, { gradeFrom: 5, gradeTo: 10 });
      expect(codes(part)).toEqual(['TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED', 'TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN']);
      expect(part.verdicts[1]).toMatchObject({
        severity: 'notice',
        params: { totalHours: 7424, gradeFrom: 5, gradeTo: 10 },
      });
      expect(part.total).toEqual({ plannedHours: 640.8, guaranteedHours: 7424, deficitHours: 0, judged: false });
      // The whole form, by span or by none, is held to it as before.
      for (const gradeSpan of [{ gradeFrom: 1, gradeTo: 10 }, null]) {
        const whole = withSpan(LAW_2028, 356, { subjects, entries }, gradeSpan);
        expect(codes(whole)).toEqual(['TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED', 'TIMPLAN_TOTAL_BELOW_GUARANTEE']);
        expect(whole.verdicts[1]!.params).not.toHaveProperty('estimated');
        expect(whole.total).not.toHaveProperty('judged');
      }
    });
  });

  describe('årskurser outside the span', () => {
    it('reports minutes there in gradesOutsideStages and counts them nowhere', () => {
      const plan = spanPlan(B1, 356, FROM_4_TO_9);
      const base = withSpan(B1, 356, plan, FROM_4_TO_9);
      const extra = [
        { subjectId: 's-MA', gradeLevel: 2, minutesPerWeek: 400 },
        { subjectId: 's-PROG', gradeLevel: 1, minutesPerWeek: 90 },
      ];
      const result = withSpan(
        B1,
        356,
        {
          subjects: [...plan.subjects, { id: 's-PROG', name: 'Programmering', nationalCode: null, countsTowardTimplan: true }],
          entries: [...plan.entries, ...extra],
        },
        FROM_4_TO_9,
      );
      expect(result.gradesOutsideStages).toEqual([1, 2]);
      expect(result.total.plannedHours).toBe(base.total.plannedHours);
      expect(result.unmapped).toEqual([]);
      expect(result.cells).toEqual(base.cells);
    });

    it('keeps förskoleklassen outside every stadium, held or not', () => {
      const plan = spanPlan(B1, 356, FROM_F_TO_5);
      const result = withSpan(B1, 356, { ...plan, entries: [...plan.entries, { subjectId: 's-MA', gradeLevel: 0, minutesPerWeek: 60 }] }, FROM_F_TO_5);
      expect(result.gradesOutsideStages).toEqual([0]);
    });
  });

  describe('a sameskola without högstadium', () => {
    it('holds åk 1–3: lågstadiet whole, the merged cell half, no mellanstadium cell', () => {
      const span: GradeSpan = { gradeFrom: 1, gradeTo: 3 };
      const result = withSpan(B4, 356, spanPlan(B4, 356, span), span);
      expect(result.verdicts).toEqual([]);
      expect(stagesOf(result)).toEqual(['LAG', 'LAG_MELLAN']);
      expect(cell(result, 'HKK', 'LAG_MELLAN').share).toEqual({ held: 3, of: 6 });
    });
  });

  describe('the span itself', () => {
    it('is refused unless two whole årskurser of a plan row in order', () => {
      const { subjects, entries } = compliantPlan(B1, 356);
      for (const bad of [
        { gradeFrom: 5, gradeTo: 4 },
        { gradeFrom: -1, gradeTo: 4 },
        { gradeFrom: 4, gradeTo: 12 },
        { gradeFrom: 4.5, gradeTo: 9 },
        { gradeFrom: 4, gradeTo: Number.NaN },
      ]) {
        expect(() => assertGradeSpan(bad)).toThrow();
        expect(() => withSpan(B1, 356, { subjects, entries }, bad)).toThrow();
      }
      expect(() => assertGradeSpan({ gradeFrom: 0, gradeTo: 11 })).not.toThrow();
      expect(() => assertGradeSpan({ gradeFrom: 7, gradeTo: 7 })).not.toThrow();
    });

    it('holds an årskurs at both of its ends, and every årskurs with no span', () => {
      expect(inGradeSpan({ gradeFrom: 4, gradeTo: 9 }, 4)).toBe(true);
      expect(inGradeSpan({ gradeFrom: 4, gradeTo: 9 }, 9)).toBe(true);
      expect(inGradeSpan({ gradeFrom: 4, gradeTo: 9 }, 3)).toBe(false);
      expect(inGradeSpan({ gradeFrom: 4, gradeTo: 9 }, 10)).toBe(false);
      expect(inGradeSpan(null, 11)).toBe(true);
      expect(inGradeSpan(undefined, 0)).toBe(true);
    });

    it('lists the held årskurser per stadium', () => {
      const stages = stageGradesFor(version(B1));
      expect(heldStageGrades(stages, FROM_F_TO_5)).toEqual({ LAG: [1, 2, 3], MELLAN: [4, 5], HOG: [] });
      expect(heldStageGrades(stages, FROM_6_TO_9)).toEqual({ LAG: [], MELLAN: [6], HOG: [7, 8, 9] });
      expect(heldStageGrades(stages, null)).toEqual(stages);
    });
  });
});
