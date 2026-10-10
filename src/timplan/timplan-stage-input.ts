import {
  deliveredPupilFigures,
  type DeliveredAudienceRow,
  type DeliveredCoverageInput,
  type DeliveredHorizonRow,
  type DeliveredMasterLesson,
  type TimplanCreditRow,
} from '../common/timplan-delivered';
import type { PlannedCoverageInput, PlannedPupilInput } from '../common/timplan-planned';
import {
  baseStageOf,
  htOf,
  pupilRegime,
  stageCutOf,
  versionGradeOf,
  type Regime,
} from '../common/timplan-cohorts';
import type { BaseStage, SchoolForm } from '../common/timplan-coverage';
import type { StageLine, StageYearCells } from '../common/timplan-stage';
import type { SegmentedAudienceRow } from './timplan-delivered.sql';

/*
 * From rows to the stage module's input: per pupil, per (läsår, årskurs), the
 * minutes P2 and P3 compute — never computed here a second way.
 *
 * Pure: the service (timplan-stage.service.ts) reads, this assembles, the
 * module (src/common/timplan-stage.ts) judges.
 *
 * ## Windows
 *
 * A year's class history is cut into WINDOWS: each distinct [from, to) a
 * segment of one of the pupils covers, clipped to the year. A pupil who sat
 * in 7A all year is in the one whole-year window with everybody else who
 * did; a pupil who moved 7A → 7B on 2 November is in [start, 2 Nov) with 7A
 * as home and [2 Nov, end] with 7B. P3 runs once per window — planned and
 * delivered with the window as its "year" (the requirement windows clip to
 * it, teachingWeeks counts its weeks, the master walk ends at its end), the
 * audience rows of the window's segments (segmentedAudienceStatement), the
 * credits dated inside it — for the pupils of that window only, and over the
 * groups that reach them. So a whole school costs one run per window, not
 * one per pupil, and only pupils who moved add windows.
 *
 * teachingWeeks charges a partly covered edge week whole, so a window that
 * ends mid-week and the next that begins in it both count that week's
 * planned minutes: a moved pupil's planned figure is at most one week per
 * move high. It never makes a shortfall; it can hide one under a week.
 *
 * ## Recorded share
 *
 * recordedPermille is the weekdays of the year the pupil sat in a class of
 * the block's årskurs over the year's weekdays. A segment whose class was
 * deleted counts nothing (the period is unrecorded, CLASS_DELETED), as do the
 * days the pupil was deactivated or not yet in the school.
 *
 * ## A year nothing was published for
 *
 * P3 says only TIMPLAN_NOT_PUBLISHED for such a year, and its figures would
 * be empty. The stage totals read it as P3's own convention reads days
 * nothing records: at plan. The run is handed a published range that begins
 * the day after the window, so every past day of the window is "before the
 * first publish" and counted at plan; the days ahead are counted at plan as
 * well (or the grundschema's projection, if larger) — a school that plans
 * but never publishes a calendar is not short of the hours its plan gives.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date: string, days: number): string =>
  new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
const isoWeekday = (date: string): number => {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
};

/** Mon–Fri days in [from, toExclusive). */
export function weekdaysBetween(from: string, toExclusive: string): number {
  if (from >= toExclusive) return 0;
  const start = new Date(`${from}T00:00:00.000Z`).getTime();
  const end = new Date(`${toExclusive}T00:00:00.000Z`).getTime();
  const days = Math.round((end - start) / DAY_MS);
  let count = Math.floor(days / 7) * 5;
  let weekday = isoWeekday(from);
  for (let rest = days % 7; rest > 0; rest -= 1) {
    if (weekday <= 5) count += 1;
    weekday = weekday === 7 ? 1 : weekday + 1;
  }
  return count;
}

export interface StageSegment {
  studentId: string;
  academicYearId: string;
  studentGroupId: string | null;
  gradeLevel: number | null;
  /** YYYY-MM-DD, inclusive. */
  from: string;
  /** YYYY-MM-DD, exclusive; null is open. */
  to: string | null;
  source: 'RECORDED' | 'BACKFILL';
}

export interface StageYearBounds {
  id: string;
  startDate: string;
  endDate: string;
}

/** A segment clipped to its year: [from, to) with to ≤ endDate + 1; null when it holds no day of it. */
export function clipToYear(segment: Pick<StageSegment, 'from' | 'to'>, year: StageYearBounds): { from: string; to: string } | null {
  const end = addDays(year.endDate, 1);
  const from = segment.from > year.startDate ? segment.from : year.startDate;
  const to = segment.to === null || segment.to > end ? end : segment.to;
  return from < to ? { from, to } : null;
}

/**
 * The dates the year is cut at for statement A + B: every clipped window's
 * start and end strictly inside the year. Sorted and distinct, so
 * width_bucket's count of thresholds ≤ a date is the date's segment.
 */
export function boundariesOf(segments: readonly StageSegment[], year: StageYearBounds): string[] {
  const end = addDays(year.endDate, 1);
  const cuts = new Set<string>();
  for (const segment of segments) {
    const window = clipToYear(segment, year);
    if (!window) continue;
    if (window.from > year.startDate) cuts.add(window.from);
    if (window.to < end) cuts.add(window.to);
  }
  return [...cuts].sort();
}

/** The segment number statement A + B gives a date: the count of boundaries on or before it. */
export function segmentOf(boundaries: readonly string[], date: string): number {
  let count = 0;
  for (const boundary of boundaries) if (boundary <= date) count += 1;
  return count;
}

/** One year's rows, as the service read them under the admin's RLS. */
export interface StageYearRead {
  year: StageYearBounds;
  /** P2's rows of the year (readPlannedRows), without pupils. */
  planned: Omit<PlannedCoverageInput, 'pupils' | 'includePupils'>;
  /** Teaching-group memberships of the year's teaching groups, for the pupils read. */
  memberships: { studentId: string; studentGroupId: string }[];
  audiences: SegmentedAudienceRow[];
  horizon: DeliveredHorizonRow[];
  published: { from: string; through: string } | null;
  publishedDays: string[];
  dates: DeliveredCoverageInput['dates'];
  boundaries: string[];
  credits: TimplanCreditRow[];
  /** The active year's grundschema (the projection ahead); empty for a past year. */
  masters: DeliveredMasterLesson[];
  publish: DeliveredCoverageInput['publish'];
  /** Each attached plan's school form, by plan id. */
  planForms: ReadonlyMap<string, SchoolForm>;
}

interface WindowPupil {
  id: string;
  homeGroupId: string;
  gradeLevel: number | null;
  source: StageSegment['source'];
}

/**
 * Every pupil's recorded blocks of one year: P3 run per window (see the
 * header), its pupil lines rolled to the national code of their subject
 * ('none', a credit without a subject, and a subject without a code go to
 * null).
 */
export function recordedBlocksOfYear(
  read: StageYearRead,
  segments: readonly StageSegment[],
  asOf: string,
  asOfDate: string,
): Map<string, StageYearCells[]> {
  const { year } = read;
  const yearWeekdays = weekdaysBetween(year.startDate, addDays(year.endDate, 1)) || 1;
  const codeOf = new Map(read.planned.subjects.map((subject) => [subject.id, subject.nationalCode]));
  const groupsById = new Map(read.planned.groups.map((group) => [group.id, group]));
  const membershipsOf = new Map<string, string[]>();
  for (const row of read.memberships) {
    const list = membershipsOf.get(row.studentId) ?? [];
    list.push(row.studentGroupId);
    membershipsOf.set(row.studentId, list);
  }

  // The windows, and the pupils in each with their home in it.
  const windows = new Map<string, { from: string; to: string; pupils: WindowPupil[] }>();
  const deleted = new Set<string>();
  for (const segment of segments) {
    const clipped = clipToYear(segment, year);
    if (!clipped) continue;
    if (segment.studentGroupId === null) {
      deleted.add(segment.studentId);
      continue;
    }
    const key = `${clipped.from}|${clipped.to}`;
    let window = windows.get(key);
    if (!window) windows.set(key, (window = { ...clipped, pupils: [] }));
    window.pupils.push({ id: segment.studentId, homeGroupId: segment.studentGroupId, gradeLevel: segment.gradeLevel, source: segment.source });
  }

  const blocks = new Map<string, Map<string, StageYearCells & { lineByCode: Map<string, StageLine> }>>();
  for (const window of [...windows.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1))) {
    const last = addDays(window.to, -1);
    const pupils: PlannedPupilInput[] = window.pupils.map((pupil) => ({
      id: pupil.id,
      homeGroupId: pupil.homeGroupId,
      groupIds: membershipsOf.get(pupil.id) ?? [],
    }));
    const pupilIds = new Set(pupils.map((pupil) => pupil.id));
    const reach = new Set(pupils.flatMap((pupil) => [pupil.homeGroupId!, ...pupil.groupIds]));
    const touches = (owner: string, extra: readonly string[], named: readonly string[]) =>
      reach.has(owner) || extra.some((id) => reach.has(id)) || named.some((id) => pupilIds.has(id));
    const lo = segmentOf(read.boundaries, window.from);
    const hi = segmentOf(read.boundaries, last);
    const audiences: DeliveredAudienceRow[] = read.audiences
      .filter((row) => row.segment >= lo && row.segment <= hi && touches(row.studentGroupId, row.extraGroupIds, row.studentIds))
      .map(({ segment: _segment, ...row }) => row);
    const masters = read.masters.filter((m) => touches(m.studentGroupId, m.extraGroupIds, m.studentIds));
    // A lesson owned by a group outside the window's reach still reaches its
    // pupils through an extra group or by name: P3 keeps a row only when its
    // owner is a group it knows, so the owners come along.
    const owners = new Set([...audiences.map((row) => row.studentGroupId), ...masters.map((m) => m.studentGroupId)]);
    const runGroups = read.planned.groups.filter((group) => reach.has(group.id) || owners.has(group.id));
    const published = read.published ?? { from: addDays(window.to, 0), through: addDays(window.to, 0) };
    const figures = deliveredPupilFigures({
      planned: {
        ...read.planned,
        year: { startDate: window.from, endDate: last },
        groups: runGroups,
        requirements: read.planned.requirements.filter((row) => reach.has(row.studentGroupId)),
        pupils,
        includePupils: true,
      },
      audiences,
      horizon: read.horizon,
      dates: read.dates,
      masterLessons: masters,
      publish: read.publish,
      credits: read.credits,
      asOf,
      asOfDate,
      published,
      ...(read.published ? { publishedDays: read.publishedDays } : {}),
      drillGroupId: null,
    });

    const share = Math.round((weekdaysBetween(window.from, window.to) * 1000) / yearWeekdays);
    for (const pupil of window.pupils) {
      // The class's årskurs as P2 and P3 judged it; the segment carries the same (kept in step).
      const grade = groupsById.get(pupil.homeGroupId)?.gradeLevel ?? pupil.gradeLevel;
      let byGrade = blocks.get(pupil.id);
      if (!byGrade) blocks.set(pupil.id, (byGrade = new Map()));
      const key = String(grade);
      let block = byGrade.get(key);
      if (!block) {
        byGrade.set(
          key,
          (block = {
            academicYearId: year.id,
            yearStartHT: htOf(year.startDate),
            gradeLevel: grade,
            schoolForm: null,
            basis: 'RECORDED',
            recordedPermille: 0,
            recordedFrom: window.from,
            backfilled: false,
            classDeleted: false,
            lines: [],
            lineByCode: new Map(),
          }),
        );
      }
      block.recordedPermille = Math.min(1000, block.recordedPermille + share);
      if (window.from < block.recordedFrom!) block.recordedFrom = window.from;
      if (pupil.source === 'BACKFILL') block.backfilled = true;
      for (const [lineKey, figure] of figures.get(pupil.id) ?? []) {
        const subjectId = lineKey === 'none' ? null : lineKey.slice('subject:'.length);
        const code = subjectId === null ? null : (codeOf.get(subjectId) ?? null);
        const codeKey = code ?? '';
        let line = block.lineByCode.get(codeKey);
        if (!line) {
          block.lineByCode.set(
            codeKey,
            (line = { code, plannedMinutes: 0, deliveredMinutes: 0, creditedMinutes: 0, atPlanMinutes: 0, aheadMinutes: 0 }),
          );
        }
        line.plannedMinutes += figure.plannedYear;
        line.deliveredMinutes += figure.delivered;
        line.creditedMinutes += figure.credited;
        line.atPlanMinutes += figure.atPlan;
        // Nothing published: the days ahead are at plan too (see the header),
        // never the shortfall of a calendar the school has not written.
        line.aheadMinutes += read.published === null ? Math.max(figure.ahead, figure.plannedYear - figure.atPlan) : figure.ahead;
      }
    }
  }

  const out = new Map<string, StageYearCells[]>();
  for (const [pupilId, byGrade] of blocks) {
    out.set(
      pupilId,
      [...byGrade.values()].map(({ lineByCode, ...block }) => ({
        ...block,
        // The attached plan's form for the årskurs, when the year attaches one.
        schoolForm: formOf(read, block.gradeLevel),
        classDeleted: deleted.has(pupilId),
        lines: [...lineByCode.values()].sort((a, b) => ((a.code ?? '') < (b.code ?? '') ? -1 : (a.code ?? '') > (b.code ?? '') ? 1 : 0)),
      })),
    );
  }
  // A pupil whose every segment this year is in a class since deleted: a
  // block that records nothing, so the stage names the year.
  for (const pupilId of deleted) {
    if (out.has(pupilId)) continue;
    const segment = segments.find((candidate) => candidate.studentId === pupilId && candidate.studentGroupId === null)!;
    out.set(pupilId, [
      {
        academicYearId: year.id,
        yearStartHT: htOf(year.startDate),
        gradeLevel: segment.gradeLevel,
        schoolForm: formOf(read, segment.gradeLevel),
        basis: 'RECORDED',
        recordedPermille: 0,
        recordedFrom: null,
        backfilled: segment.source === 'BACKFILL',
        classDeleted: true,
        lines: [],
      },
    ]);
  }
  return out;
}

/** The form of the plan a year attaches to an årskurs, or null. */
function formOf(read: Pick<StageYearRead, 'planned' | 'planForms'>, gradeLevel: number | null): SchoolForm | null {
  if (gradeLevel === null) return null;
  const attachment = read.planned.attachments.find((row) => row.gradeLevel === gradeLevel);
  if (!attachment) return null;
  return read.planForms.get(attachment.localTimplanId) ?? null;
}

/** A plan a future grade can read: its form, weeks and entries. */
export interface FuturePlan {
  id: string;
  schoolForm: SchoolForm;
  /** planningWeeks × 10. */
  planningWeeksTenths: number;
  entries: { subjectId: string; gradeLevel: number; minutesPerWeek: number }[];
}

/**
 * The grades of the pupil's current stage still ahead, each a FUTURE block
 * with the target of the plan the cohort carries (§2.4 of the spec): the
 * successor year's attachment for next year's årskurs when the active year
 * has been rolled, otherwise the plan the pupil's årskurs follows this year —
 * its entries for the future version grade, × the plan's planningWeeks. No
 * plan: a block that records nothing (unplanned). Up to the end of the
 * current stage, and through mellanstadiet from lågstadiet (HKK's merged
 * cell spans both).
 */
export function futureBlocks(args: {
  regime: Regime;
  activeHT: number;
  currentGrade: number | null;
  schoolForm: SchoolForm;
  currentPlan: FuturePlan | null;
  /** The successor year's plan per årskurs (its own numbering), when rolled. */
  successorPlans: ReadonlyMap<number, FuturePlan>;
  codeOf: ReadonlyMap<string, string | null>;
  counts: ReadonlySet<string>;
}): StageYearCells[] {
  const { regime, activeHT, currentGrade } = args;
  const versionGrade = versionGradeOf(regime, activeHT, currentGrade);
  const cut = stageCutOf(regime, args.schoolForm);
  const base = baseStageOf(cut, versionGrade);
  if (versionGrade === null || base === null) return [];
  const through: BaseStage[] = base === 'LAG' ? ['LAG', 'MELLAN'] : [base];
  const last = Math.max(...through.flatMap((stage) => cut[stage]));
  const out: StageYearCells[] = [];
  for (let step = 1; versionGrade + step <= last; step += 1) {
    const grade = versionGrade + step;
    const ht = activeHT + step;
    // The year's own numbering: an old-cohort pupil sits one above their version grade from HT 2028.
    const gradeLevel = regime === 'PRE_2028' && ht >= 2028 ? grade + 1 : grade;
    const plan = (step === 1 ? args.successorPlans.get(gradeLevel) : undefined) ?? args.currentPlan;
    const entries = (plan?.entries ?? []).filter((entry) => entry.gradeLevel === grade && args.counts.has(entry.subjectId));
    const byCode = new Map<string, StageLine>();
    for (const entry of entries) {
      const code = args.codeOf.get(entry.subjectId) ?? null;
      const minutes = Math.round((entry.minutesPerWeek * plan!.planningWeeksTenths) / 10);
      const key = code ?? '';
      const line = byCode.get(key) ?? { code, plannedMinutes: 0, deliveredMinutes: 0, creditedMinutes: 0, atPlanMinutes: 0, aheadMinutes: 0 };
      line.plannedMinutes += minutes;
      line.aheadMinutes += minutes;
      byCode.set(key, line);
    }
    out.push({
      academicYearId: null,
      yearStartHT: ht,
      gradeLevel,
      schoolForm: plan?.schoolForm ?? null,
      basis: 'FUTURE',
      recordedPermille: entries.length > 0 ? 1000 : 0,
      recordedFrom: null,
      backfilled: false,
      classDeleted: false,
      lines: [...byCode.values()].sort((a, b) => ((a.code ?? '') < (b.code ?? '') ? -1 : 1)),
    });
  }
  return out;
}

/** The regime a pupil's recorded blocks give (the module decides the same from the same blocks). */
export function regimeOfBlocks(blocks: readonly StageYearCells[]): Regime {
  return pupilRegime(blocks.filter((block) => block.basis === 'RECORDED').map((block) => ({ ht: block.yearStartHT, gradeLevel: block.gradeLevel })));
}
