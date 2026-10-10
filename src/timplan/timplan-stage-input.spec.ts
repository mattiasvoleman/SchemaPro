import { planningWeeksInTenths } from '../common/timplan-coverage';
import type { PlannedGroup, PlannedRequirement } from '../common/timplan-planned';
import {
  boundariesOf,
  clipToYear,
  futureBlocks,
  recordedBlocksOfYear,
  segmentOf,
  weekdaysBetween,
  type StageSegment,
  type StageYearRead,
} from './timplan-stage-input';
import type { SegmentedAudienceRow } from './timplan-delivered.sql';
import { computePupilStages } from '../common/timplan-stage';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const YEAR = { id: id(900), startDate: '2026-08-17', endDate: '2027-06-11' };
const MA = id(1);
const SVA = id(2);
const RES = id(3);
const g7a: PlannedGroup = { id: id(71), name: '7A', kind: 'CLASS', gradeLevel: 7 };
const g7b: PlannedGroup = { id: id(72), name: '7B', kind: 'CLASS', gradeLevel: 7 };
const req = (group: PlannedGroup, subjectId: string, lessons: number): PlannedRequirement => ({
  id: `${group.id}-${subjectId}`,
  studentGroupId: group.id,
  subjectId,
  lessonsPerWeek: lessons,
  minutesPerLesson: 60,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
});
const seg = (studentId: string, group: PlannedGroup | null, from: string, to: string | null, extra: Partial<StageSegment> = {}): StageSegment => ({
  studentId,
  academicYearId: YEAR.id,
  studentGroupId: group?.id ?? null,
  gradeLevel: 7,
  from,
  to,
  source: 'RECORDED',
  ...extra,
});
const read = (extra: Partial<StageYearRead> = {}): StageYearRead => ({
  year: YEAR,
  planned: {
    year: { startDate: YEAR.startDate, endDate: YEAR.endDate },
    closures: [],
    plans: [],
    attachments: [],
    subjects: [
      { id: MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
      { id: SVA, name: 'Svenska', nationalCode: 'SV_SVA', countsTowardTimplan: true },
      { id: RES, name: 'Resurs', nationalCode: null, countsTowardTimplan: false },
    ],
    groups: [g7a, g7b],
    requirements: [req(g7a, MA, 3), req(g7b, MA, 4), req(g7a, RES, 1)],
  },
  memberships: [],
  audiences: [],
  horizon: [],
  published: null,
  publishedDays: [],
  dates: [],
  boundaries: [],
  credits: [],
  masters: [],
  publish: { breaks: [], closures: [], timezone: 'Europe/Stockholm' },
  planForms: new Map(),
  ...extra,
});

describe('the stage totals’ windows', () => {
  it('counts weekdays, the end exclusive', () => {
    expect(weekdaysBetween('2026-10-05', '2026-10-12')).toBe(5); // Mon to Mon
    expect(weekdaysBetween('2026-10-09', '2026-10-13')).toBe(2); // Fri, Mon
    expect(weekdaysBetween('2026-10-10', '2026-10-10')).toBe(0);
  });

  it('clips a segment to its year, and drops one holding no day of it', () => {
    expect(clipToYear({ from: '2026-08-01', to: null }, YEAR)).toEqual({ from: '2026-08-17', to: '2027-06-12' });
    expect(clipToYear({ from: '2026-11-02', to: '2027-01-11' }, YEAR)).toEqual({ from: '2026-11-02', to: '2027-01-11' });
    // A straggler's segment from the ended year's end + 1.
    expect(clipToYear({ from: '2027-06-12', to: null }, YEAR)).toBeNull();
  });

  it('cuts the year at every move and nowhere else, and numbers dates as width_bucket does', () => {
    const segments = [
      seg(id(1), g7a, '2026-08-17', '2026-11-02'),
      seg(id(1), g7b, '2026-11-02', null),
      seg(id(2), g7a, '2026-08-17', null),
    ];
    const boundaries = boundariesOf(segments, YEAR);
    expect(boundaries).toEqual(['2026-11-02']);
    expect([segmentOf(boundaries, '2026-09-01'), segmentOf(boundaries, '2026-11-02'), segmentOf(boundaries, '2027-03-01')]).toEqual([0, 1, 1]);
  });
});

describe('recordedBlocksOfYear', () => {
  it('splits a moved pupil’s year at the move: 7A’s minutes before, 7B’s after, one block recorded in full', () => {
    const anna = id(101);
    const bo = id(102);
    const segments = [seg(anna, g7a, '2026-08-17', '2026-11-02'), seg(anna, g7b, '2026-11-02', null), seg(bo, g7a, '2026-08-17', null)];
    const blocks = recordedBlocksOfYear(read({ boundaries: boundariesOf(segments, YEAR) }), segments, '2026-10-10T08:00:00.000Z', '2026-10-10');
    const [annaBlock] = blocks.get(anna)!;
    const [boBlock] = blocks.get(bo)!;
    expect(annaBlock).toMatchObject({ gradeLevel: 7, basis: 'RECORDED', recordedPermille: 1000, recordedFrom: '2026-08-17', classDeleted: false });
    expect(boBlock!.recordedPermille).toBe(1000);
    const ma = (block: typeof annaBlock) => block!.lines.find((line) => line.code === 'MA')!;
    // Bo: 3 × 60 all year. Anna: 3 × 60 until November, 4 × 60 after it.
    expect(ma(annaBlock).plannedMinutes).toBeGreaterThan(ma(boBlock).plannedMinutes);
    // Nothing published: every past day and every day ahead at plan.
    expect(ma(boBlock).deliveredMinutes).toBe(0);
    expect(ma(boBlock).atPlanMinutes + ma(boBlock).aheadMinutes).toBeGreaterThanOrEqual(ma(boBlock).plannedMinutes);
    // A subject that does not count toward the timplan is in no line.
    expect(boBlock!.lines.map((line) => line.code)).toEqual(['MA']);
  });

  it('reads the year’s held lessons by segment: 7A’s rows of segment 0 reach the mover, segment 1 does not', () => {
    const anna = id(101);
    const segments = [seg(anna, g7a, '2026-08-17', '2026-09-14'), seg(anna, g7b, '2026-09-14', null)];
    const row = (group: PlannedGroup, segment: number, minutes: number): SegmentedAudienceRow => ({
      studentGroupId: group.id,
      subjectId: MA,
      bucket: 'DELIVERED',
      extraGroupIds: [],
      studentIds: [],
      segment,
      minutes,
      lessons: minutes / 60,
    });
    const blocks = recordedBlocksOfYear(
      read({
        boundaries: ['2026-09-14'],
        published: { from: '2026-08-17', through: '2027-06-11' },
        audiences: [row(g7a, 0, 600), row(g7a, 1, 1200), row(g7b, 0, 900), row(g7b, 1, 300)],
      }),
      segments,
      '2026-10-10T08:00:00.000Z',
      '2026-10-10',
    );
    expect(blocks.get(anna)![0]!.lines.find((line) => line.code === 'MA')!.deliveredMinutes).toBe(600 + 300);
  });

  it('counts days in a class since deleted, and days away, as unrecorded — never as zero minutes recorded', () => {
    const anna = id(101);
    const cleo = id(103);
    const segments = [
      seg(anna, g7a, '2026-08-17', '2026-11-02'),
      seg(anna, null, '2026-11-02', null), // the class she moved to was deleted
      seg(cleo, g7a, '2027-01-11', null), // came in January
    ];
    const blocks = recordedBlocksOfYear(read({ boundaries: boundariesOf(segments, YEAR) }), segments, '2026-10-10T08:00:00.000Z', '2026-10-10');
    expect(blocks.get(anna)![0]).toMatchObject({ classDeleted: true });
    expect(blocks.get(anna)![0]!.recordedPermille).toBeLessThan(400);
    expect(blocks.get(cleo)![0]!.recordedPermille).toBeLessThan(600);
    expect(blocks.get(cleo)![0]!.recordedFrom).toBe('2027-01-11');
  });

  it('reads a home group that is not a class as unrecorded, as P2 and P3 do — never as a year recorded in full at 0 h', () => {
    // Users.studentGroupId may name a teaching group; P3 drops a pupil whose
    // home is not a CLASS, so their figures would be empty while the trigger
    // records the segment.
    const tg8: PlannedGroup = { id: id(81), name: 'Ma8 nivå', kind: 'TEACHING_GROUP', gradeLevel: 8 };
    const dag = id(104);
    const eva = id(105);
    const segments = [
      seg(dag, tg8, '2026-08-17', null, { gradeLevel: 8 }),
      seg(eva, tg8, '2026-08-17', '2026-11-02', { gradeLevel: 8 }),
      seg(eva, g7a, '2026-11-02', null),
    ];
    const blocks = recordedBlocksOfYear(
      read({ boundaries: boundariesOf(segments, YEAR), planned: { ...read().planned, groups: [g7a, g7b, tg8] } }),
      segments,
      '2026-10-10T08:00:00.000Z',
      '2026-10-10',
    );
    expect(blocks.get(dag)).toEqual([
      expect.objectContaining({ gradeLevel: 8, recordedPermille: 0, recordedFrom: null, homeNotClass: true, lines: [] }),
    ]);
    // Eva's months in 7A are recorded; the months before are not.
    const [evaBlock] = blocks.get(eva)!;
    expect(evaBlock).toMatchObject({ gradeLevel: 7, recordedFrom: '2026-11-02', homeNotClass: true });
    expect(evaBlock!.recordedPermille).toBeLessThan(800);

    // And the module reads Dag's year as no class: unrecorded, a notice, no shortfall.
    const coverage = computePupilStages({
      asOfDate: '2026-10-10',
      activeYearId: YEAR.id,
      versions: [],
      nationalSubjects: [],
      pupils: [{ id: dag, homeGroupId: tg8.id, years: blocks.get(dag)! }],
    });
    const verdicts = coverage.pupils[0]!.verdicts.map((verdict) => verdict.code);
    expect(verdicts).toEqual(expect.arrayContaining(['TIMPLAN_PUPIL_STAGE_HOME_NOT_A_CLASS', 'TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED']));
    expect(verdicts.filter((code) => code.includes('BELOW'))).toEqual([]);
    expect(coverage.pupils[0]!.stages.find((entry) => entry.stage === 'HOG')).toMatchObject({ recordedGrades: [], unrecordedGrades: [7, 8, 9], complete: false });
  });

  it('puts nothing ahead in a year that has ended when nothing was published: a mover projects what a stayer with the same lessons does', () => {
    // 7A and 7B both 3 × 60 a week; Anna moves on a Wednesday, Bo stays.
    // teachingWeeks charges each window's edge week whole, so the mover's
    // planned figure is up to a week high (documented); in a year that has
    // ended that must not leak into what is "ahead".
    const anna = id(101);
    const bo = id(102);
    const segments = [seg(anna, g7a, '2026-08-17', '2026-11-04'), seg(anna, g7b, '2026-11-04', null), seg(bo, g7a, '2026-08-17', null)];
    const same = read({
      boundaries: boundariesOf(segments, YEAR),
      planned: { ...read().planned, requirements: [req(g7a, MA, 3), req(g7b, MA, 3)] },
    });
    const blocks = recordedBlocksOfYear(same, segments, '2027-08-02T08:00:00.000Z', '2027-08-02');
    const ma = (pupil: string) => blocks.get(pupil)![0]!.lines.find((line) => line.code === 'MA')!;
    expect(ma(bo).aheadMinutes).toBe(0);
    expect(ma(anna).aheadMinutes).toBe(0);
    const projected = (pupil: string) => ma(pupil).deliveredMinutes + ma(pupil).atPlanMinutes + ma(pupil).creditedMinutes + ma(pupil).aheadMinutes;
    expect(projected(anna)).toBe(projected(bo));
  });

  it('names a backfilled segment', () => {
    const anna = id(101);
    const segments = [seg(anna, g7a, '2026-08-17', null, { source: 'BACKFILL' })];
    expect(recordedBlocksOfYear(read(), segments, '2026-10-10T08:00:00.000Z', '2026-10-10').get(anna)![0]!.backfilled).toBe(true);
  });
});

describe('futureBlocks', () => {
  const plan = {
    id: id(500),
    schoolForm: 'GRUNDSKOLA' as const,
    planningWeeksTenths: planningWeeksInTenths('35.6'),
    entries: [
      { subjectId: MA, gradeLevel: 8, minutesPerWeek: 180 },
      { subjectId: MA, gradeLevel: 9, minutesPerWeek: 120 },
    ],
  };
  const base = {
    regime: 'PRE_2028' as const,
    activeHT: 2026,
    currentGrade: 7,
    schoolForm: 'GRUNDSKOLA' as const,
    currentPlan: plan,
    successorPlans: new Map(),
    codeOf: new Map([[MA, 'MA']]),
    counts: new Set([MA]),
  };

  it('carries the current plan to the stage’s grades ahead, at its planningWeeks', () => {
    const blocks = futureBlocks(base);
    expect(blocks.map((block) => [block.yearStartHT, block.gradeLevel, block.recordedPermille])).toEqual([
      [2027, 8, 1000],
      // 2028/29 in the new numbering: the old cohort's version grade 9 is åk 10.
      [2028, 10, 1000],
    ]);
    expect(blocks[0]!.lines).toEqual([
      { code: 'MA', plannedMinutes: 6408, deliveredMinutes: 0, creditedMinutes: 0, atPlanMinutes: 0, aheadMinutes: 6408 },
    ]);
  });

  it('prefers the rolled successor’s plan for next year’s årskurs', () => {
    const next = { ...plan, id: id(501), entries: [{ subjectId: MA, gradeLevel: 8, minutesPerWeek: 200 }] };
    const blocks = futureBlocks({ ...base, successorPlans: new Map([[8, next]]) });
    expect(blocks[0]!.lines[0]!.plannedMinutes).toBe(7120);
  });

  it('leaves a grade no plan speaks for unplanned, and a pupil without a grade nothing ahead', () => {
    expect(futureBlocks({ ...base, currentPlan: null }).map((block) => block.recordedPermille)).toEqual([0, 0]);
    expect(futureBlocks({ ...base, currentGrade: null })).toEqual([]);
  });

  it('reaches through mellanstadiet from lågstadiet (HKK’s merged cell)', () => {
    // Version grades 3–6; from 2028/29 the old cohort's årskurs is one above them.
    expect(futureBlocks({ ...base, currentGrade: 2, currentPlan: null }).map((block) => block.gradeLevel)).toEqual([3, 5, 6, 7]);
  });
});
