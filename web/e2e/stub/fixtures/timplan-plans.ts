import type { NationalTimplanVersion, Subject } from "../../../lib/types";
import type { CellCoverage, TimplanStage, TimplanVerdict } from "../../../lib/timplan-coverage";
import type { TimplanCredit } from "../../../lib/timplan-credit-queries";
import type {
  LocalTimplanCheckResponse,
  LocalTimplanDetail,
  LocalTimplanEntry,
  LocalTimplanListItem,
} from "../../../lib/timplan-queries";
import type { YearTimplanRow } from "../../../lib/year-timplan-queries";
import { KIND, uid } from "../sessions";
import { addDays, AUTUMN_YEAR, isoWeekday, NEXT_YEAR_NAME, stockholmInstant, TODAY, YEAR_END, YEAR_START } from "./calendar";
import { SCHOOL_BREAKS } from "./school-days";
import { BILAGA_1, NATIONAL_NAME, PARENT_OF } from "./timplan-national";
import { ADMIN, GROUPS, NEXT_YEAR, SCHOOL, SUBJECT_LIST, SUBJECTS, YEAR } from "./world";

/**
 * Exempelskolan's lokala timplaner: the decided one this läsår's åk 7–9
 * follow, and next läsår's draft copied from it. Ids are uid(KIND.misc,
 * 7000–7999), the timplan area's range.
 */

// --- National codes --------------------------------------------------------------

/** Svenska/SvA and språkval: a pupil reads one of the alternatives, so a cell takes the longest. */
export const ALTERNATIVE_CODES = ["SV_SVA", "M2"];

// --- Teaching weeks ------------------------------------------------------------

/** Weekdays in [from, to) outside every lov and studiedag, divided by five. */
export function teachingWeeksBetween(from: string, to: string): number {
  let days = 0;
  for (let date = from; date < to; date = addDays(date, 1)) {
    if (isoWeekday(date) > 5) continue;
    if (SCHOOL_BREAKS.some((entry) => entry.startDate <= date && date <= entry.endDate)) continue;
    days++;
  }
  return days / 5;
}

/** The läsår's teaching weeks, which the gateway turns minutes per week into hours with. */
export const YEAR_WEEKS = teachingWeeksBetween(YEAR_START, addDays(YEAR_END, 1));

/** The first weekday on or after `date`. */
export const weekdayFrom = (date: string) => (isoWeekday(date) > 5 ? addDays(date, 8 - isoWeekday(date)) : date);

// --- The plans -----------------------------------------------------------------

/**
 * Minutes per week in åk 7, 8 and 9. At 35,6 weeks each clears its own line of
 * bilaga 1 (biologi and historia their minima); NO and SO as groups do not, as
 * the school teaches no fysik, kemi, geografi, religion or samhällskunskap.
 */
const DECIDED_MINUTES: Array<[Subject, [number, number, number]]> = [
  [SUBJECTS.sv, [165, 165, 160]],
  [SUBJECTS.ma, [225, 225, 225]],
  [SUBJECTS.en, [110, 110, 120]],
  [SUBJECTS.no, [50, 45, 45]],
  [SUBJECTS.so, [55, 60, 55]],
  [SUBJECTS.idh, [160, 155, 160]],
  [SUBJECTS.bl, [60, 55, 55]],
  [SUBJECTS.m2, [150, 155, 155]],
];

/** Next year's proposal: more matematik, and idrott cut below bilaga 1 (a notice within the 20 %). */
const DRAFT_MINUTES: Array<[Subject, [number, number, number]]> = DECIDED_MINUTES.map(([entry, minutes]) => [
  entry,
  entry === SUBJECTS.ma ? [240, 240, 240] : entry === SUBJECTS.idh ? [150, 150, 155] : minutes,
]);

const entriesOf = (base: number, rows: Array<[Subject, [number, number, number]]>): LocalTimplanEntry[] =>
  rows
    .flatMap(([entry, minutes]) =>
      minutes.map((minutesPerWeek, index) => ({ subjectId: entry.id, gradeLevel: 7 + index, minutesPerWeek })),
    )
    // The gateway's order: årskurs, then subject id.
    .sort((a, b) => a.gradeLevel - b.gradeLevel || (a.subjectId < b.subjectId ? -1 : 1))
    .map((entry, index) => ({ id: uid(KIND.misc, base + index), ...entry, note: null }));

// Decided before the läsår began; the proposal drafted a few weeks ago.
const decidedAt = stockholmInstant(addDays(YEAR_START, -63), "15:20");

export const DECIDED_PLAN: LocalTimplanDetail = {
  id: uid(KIND.misc, 7001),
  schoolId: SCHOOL.id,
  name: "Timplan åk 7–9",
  schoolForm: "GRUNDSKOLA",
  nationalTimplanVersionId: BILAGA_1.id,
  planningWeeks: 35.6,
  status: "DECIDED",
  decidedAt,
  decidedByUserId: ADMIN.id,
  decisionNote: "Fastställd av rektor på delegation från huvudmannen.",
  copiedFromId: null,
  createdAt: stockholmInstant(addDays(YEAR_START, -90), "09:00"),
  updatedAt: decidedAt,
  entries: entriesOf(7100, DECIDED_MINUTES),
};

export const DRAFT_PLAN: LocalTimplanDetail = {
  id: uid(KIND.misc, 7002),
  schoolId: SCHOOL.id,
  name: `Timplan åk 7–9 från ${NEXT_YEAR_NAME}`,
  schoolForm: "GRUNDSKOLA",
  nationalTimplanVersionId: BILAGA_1.id,
  planningWeeks: 35.6,
  status: "DRAFT",
  decidedAt: null,
  decidedByUserId: null,
  decisionNote: null,
  copiedFromId: DECIDED_PLAN.id,
  createdAt: stockholmInstant(addDays(TODAY, -21), "13:45"),
  updatedAt: stockholmInstant(addDays(TODAY, -14), "10:05"),
  entries: entriesOf(7200, DRAFT_MINUTES),
};

export const PLANS = [DECIDED_PLAN, DRAFT_PLAN];

/** GET /local-timplans: by name, as the gateway lists them, with no entries. */
export const PLAN_LIST: LocalTimplanListItem[] = [...PLANS]
  .sort((a, b) => a.name.localeCompare(b.name, "sv"))
  .map(({ entries, ...plan }) => ({ ...plan, entryCount: entries.length }));

/** Timplan per årskurs: this läsår follows the decided plan, the rolled one the draft. */
export const YEAR_TIMPLANS: Record<string, YearTimplanRow[]> = {
  [YEAR.id]: [7, 8, 9].map((gradeLevel) => ({
    gradeLevel,
    localTimplanId: DECIDED_PLAN.id,
    planName: DECIDED_PLAN.name,
    planStatus: DECIDED_PLAN.status,
  })),
  [NEXT_YEAR.id]: [7, 8, 9].map((gradeLevel) => ({
    gradeLevel,
    localTimplanId: DRAFT_PLAN.id,
    planName: DRAFT_PLAN.name,
    planStatus: DRAFT_PLAN.status,
  })),
};

// --- Tillgodoräknad tid ----------------------------------------------------------

export const CREDITS: TimplanCredit[] = [
  {
    id: uid(KIND.misc, 7301),
    academicYearId: YEAR.id,
    date: weekdayFrom(`${AUTUMN_YEAR}-09-17`),
    minutes: 300,
    subjectId: SUBJECTS.idh.id,
    studentGroupId: null,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    name: "Friluftsdag",
    note: "Vandring och orientering i naturreservatet.",
  },
  {
    id: uid(KIND.misc, 7302),
    academicYearId: YEAR.id,
    date: weekdayFrom(`${AUTUMN_YEAR}-10-08`),
    minutes: 120,
    subjectId: SUBJECTS.sv.id,
    studentGroupId: GROUPS.g7A.id,
    minGradeLevel: null,
    maxGradeLevel: null,
    name: "Författarbesök",
    note: null,
  },
];

// --- The check: den lokala timplanen mot den nationella ----------------------------

/*
 * GET /local-timplans/:id/check, computed here by the arithmetic of
 * lib/timplan-coverage.ts (minute-tenths, a short figure rounded down, a
 * deficit up), for what this school's plans use: grundskolan's 1–3 / 4–6 /
 * 7–9, codes with and without ämnesgrupp, the two alternatives. A plan for
 * åk 7–9 alone leaves every lågstadie and mellanstadie cell empty, and the
 * gateway says so cell by cell — so does this.
 */

const HOUR = 600;
const hours = (tenths: number) => Math.round(tenths / 60) / 10;
const hoursDown = (tenths: number) => Math.floor(tenths / 60) / 10;
const hoursUp = (tenths: number) => Math.ceil(tenths / 60) / 10;
const percentUp = (part: number, whole: number) => (whole === 0 ? 0 : Math.ceil((part * 1000) / whole) / 10);
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const STAGE_ORDER: Record<TimplanStage, number> = { LAG: 0, LAG_MELLAN: 1, MELLAN: 2, HOG: 3 };
/** Bilaga 1's cut, a nine-year grundskola: 1–3, 4–6, 7–9. */
const stageOfGrade = (gradeLevel: number): "LAG" | "MELLAN" | "HOG" | undefined =>
  gradeLevel < 1 || gradeLevel > 9 ? undefined : gradeLevel <= 3 ? "LAG" : gradeLevel <= 6 ? "MELLAN" : "HOG";
const VERDICT_ORDER: TimplanVerdict["code"][] = [
  "TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED",
  "TIMPLAN_SUBJECT_UNMAPPED",
  "TIMPLAN_PROTECTED_SUBJECT_REDUCED",
  "TIMPLAN_REDUCTION_OVER_CAP",
  "TIMPLAN_GROUP_MINIMUM_UNMET",
  "TIMPLAN_STAGE_BELOW_NATIONAL",
  "TIMPLAN_SKOLANS_VAL_OVERSPENT",
  "TIMPLAN_TOTAL_BELOW_GUARANTEE",
];

interface CellSum {
  code: string;
  stage: TimplanStage;
  national: number;
  planned: number;
  protectedFromReduction: boolean;
  minima: Map<string, number>;
  childPlanned: Map<string, number>;
  longest: Map<number, number>;
  subjectIds: Set<string>;
  judged: boolean;
}

function checkPlan(plan: LocalTimplanDetail, version: NationalTimplanVersion) {
  const weeks = Math.round(plan.planningWeeks * 10);
  const sums = new Map<string, CellSum>();
  const cellOf = (code: string, stage: TimplanStage, national = 0, prot = false) => {
    const key = `${code}:${stage}`;
    let sum = sums.get(key);
    if (!sum) {
      sum = {
        code,
        stage,
        national,
        planned: 0,
        protectedFromReduction: prot,
        minima: new Map(),
        childPlanned: new Map(),
        longest: new Map(),
        subjectIds: new Set(),
        judged: false,
      };
      sums.set(key, sum);
    }
    return sum;
  };
  for (const entry of version.entries) {
    if (!PARENT_OF.get(entry.subjectCode)) cellOf(entry.subjectCode, entry.stage, entry.hours * HOUR, entry.protectedFromReduction);
  }
  for (const entry of version.entries) {
    const parent = PARENT_OF.get(entry.subjectCode);
    if (parent) cellOf(parent, entry.stage).minima.set(entry.subjectCode, entry.hours * HOUR);
  }
  const merged = new Set(version.entries.filter((entry) => entry.stage === "LAG_MELLAN").map((entry) => entry.subjectCode));

  for (const entry of plan.entries) {
    const school = SUBJECT_LIST.find((candidate) => candidate.id === entry.subjectId);
    const base = stageOfGrade(entry.gradeLevel);
    if (!school?.countsTowardTimplan || !school.nationalCode || !base || entry.minutesPerWeek <= 0) continue;
    const code = school.nationalCode;
    const top = PARENT_OF.get(code) ?? code;
    const sum = cellOf(top, base !== "HOG" && merged.has(top) ? "LAG_MELLAN" : base);
    const tenths = entry.minutesPerWeek * weeks;
    sum.subjectIds.add(school.id);
    if (ALTERNATIVE_CODES.includes(top)) {
      sum.longest.set(entry.gradeLevel, Math.max(sum.longest.get(entry.gradeLevel) ?? 0, tenths));
      continue;
    }
    sum.planned += tenths;
    if (code !== top) {
      sum.childPlanned.set(code, (sum.childPlanned.get(code) ?? 0) + tenths);
      sum.judged = true;
    }
  }
  for (const sum of sums.values()) for (const tenths of sum.longest.values()) sum.planned += tenths;

  const cap = version.reductionCapPercent;
  const verdicts: TimplanVerdict[] = [];
  let taken = 0;
  let total = 0;
  let placed = 0;
  const cells: CellCoverage[] = [...sums.values()]
    .sort((a, b) => byCode(a.code, b.code) || STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage])
    .map((sum) => {
      const deficit = Math.max(0, sum.national - sum.planned);
      const surplus = Math.max(0, sum.planned - sum.national);
      taken += deficit;
      placed += surplus;
      total += sum.planned;
      const subjectIds = [...sum.subjectIds].sort(byCode);
      const where = { subjectCode: sum.code, stage: sum.stage, subjectIds };
      const plannedShown = deficit > 0 ? hoursDown(sum.planned) : hours(sum.planned);
      if (deficit > 0) {
        const figures = {
          nationalHours: sum.national / HOUR,
          plannedHours: plannedShown,
          deficitHours: hoursUp(deficit),
          reducedPercent: percentUp(deficit, sum.national),
        };
        if (sum.protectedFromReduction) {
          verdicts.push({ code: "TIMPLAN_PROTECTED_SUBJECT_REDUCED", severity: "warning", ...where, params: figures });
        } else if (cap !== null && deficit * 100 > cap * sum.national) {
          verdicts.push({ code: "TIMPLAN_REDUCTION_OVER_CAP", severity: "warning", ...where, params: { ...figures, capPercent: cap } });
        } else {
          verdicts.push({ code: "TIMPLAN_STAGE_BELOW_NATIONAL", severity: "notice", ...where, params: { ...figures, timeCountsAs: "skolansVal" } });
        }
      }
      const children = [...sum.minima.entries()].sort(([a], [b]) => byCode(a, b)).map(([childCode, minimum]) => {
        const childPlanned = sum.childPlanned.get(childCode) ?? 0;
        const shown = childPlanned < minimum ? hoursDown(childPlanned) : hours(childPlanned);
        if (sum.judged && childPlanned < minimum) {
          verdicts.push({
            code: "TIMPLAN_GROUP_MINIMUM_UNMET",
            severity: "warning",
            ...where,
            childCode,
            params: { childCode, minimumHours: minimum / HOUR, plannedHours: shown, deficitHours: hoursUp(minimum - childPlanned) },
          });
        }
        return { subjectCode: childCode, minimumHours: minimum / HOUR, plannedHours: shown };
      });
      return {
        subjectCode: sum.code,
        stage: sum.stage,
        nationalHours: sum.national / HOUR,
        plannedHours: plannedShown,
        deficitHours: hoursUp(deficit),
        surplusHours: hours(surplus),
        reducedPercent: percentUp(deficit, sum.national),
        protectedFromReduction: sum.protectedFromReduction,
        ...(children.length > 0 ? { children } : {}),
        subjectIds,
      };
    });

  const pool = version.skolansValHours;
  if (pool !== null && taken > pool * HOUR) {
    verdicts.push({
      code: "TIMPLAN_SKOLANS_VAL_OVERSPENT",
      severity: "warning",
      params: { takenHours: hoursUp(taken), availableHours: pool, overspentHours: hoursUp(taken - pool * HOUR) },
    });
  }
  const guaranteed = version.totalHours * HOUR;
  const totalShown = total < guaranteed ? hoursDown(total) : hours(total);
  if (total < guaranteed) {
    verdicts.push({
      code: "TIMPLAN_TOTAL_BELOW_GUARANTEE",
      severity: "warning",
      params: { plannedHours: totalShown, guaranteedHours: version.totalHours, deficitHours: hoursUp(guaranteed - total) },
    });
  }
  verdicts.sort(
    (a, b) =>
      VERDICT_ORDER.indexOf(a.code) - VERDICT_ORDER.indexOf(b.code) ||
      (a.stage ? STAGE_ORDER[a.stage] : -1) - (b.stage ? STAGE_ORDER[b.stage] : -1) ||
      byCode(a.subjectCode ?? "", b.subjectCode ?? "") ||
      byCode(a.childCode ?? "", b.childCode ?? ""),
  );

  return {
    versionCode: version.code,
    distributionPublished: version.entries.length > 0,
    planningWeeks: weeks / 10,
    stageGrades: { LAG: [1, 2, 3], MELLAN: [4, 5, 6], HOG: [7, 8, 9] },
    cells,
    unmapped: [],
    gradesOutsideStages: [],
    skolansVal: { availableHours: pool, takenHours: hoursUp(taken), placedHours: hours(placed) },
    total: { plannedHours: totalShown, guaranteedHours: version.totalHours, deficitHours: hoursUp(Math.max(0, guaranteed - total)) },
    verdicts,
  };
}

// The gateway's Swedish sentence (src/timplan/timplan-verdict-messages.ts), for the codes these plans raise.
const STAGE_TEXT: Record<TimplanStage, string> = {
  LAG: "lågstadiet",
  MELLAN: "mellanstadiet",
  HOG: "högstadiet",
  LAG_MELLAN: "låg- och mellanstadiet",
};
const number = new Intl.NumberFormat("sv-SE", { maximumFractionDigits: 1 });
const h = (value: string | number | undefined) => `${number.format(Number(value ?? 0))} h`;
const pct = (value: string | number | undefined) => `${number.format(Number(value ?? 0))} %`;

function describe(verdict: TimplanVerdict): string {
  const p = verdict.params;
  const name = (code: string | undefined) => (code ? (NATIONAL_NAME.get(code) ?? code) : "");
  const stage = verdict.stage ? STAGE_TEXT[verdict.stage] : "";
  const where = `${name(verdict.subjectCode)} i ${stage}`;
  switch (verdict.code) {
    case "TIMPLAN_PROTECTED_SUBJECT_REDUCED":
      return `${where}: ${h(p.plannedHours)} planerat, ${h(p.deficitHours)} under målet ${h(p.nationalHours)}. Ämnet får inte minskas för skolans val.`;
    case "TIMPLAN_REDUCTION_OVER_CAP":
      return `${where}: ${h(p.plannedHours)} planerat, ${pct(p.reducedPercent)} under målet ${h(p.nationalHours)}. Skolans val får minska ett ämne med högst ${pct(p.capPercent)} per stadium.`;
    case "TIMPLAN_GROUP_MINIMUM_UNMET":
      return `${name(verdict.childCode)} i ${stage}: ${h(p.plannedHours)} planerat, under minsta tiden ${h(p.minimumHours)} inom ${name(verdict.subjectCode).toLowerCase()}.`;
    case "TIMPLAN_STAGE_BELOW_NATIONAL":
      return `${where}: ${h(p.plannedHours)} planerat, ${h(p.deficitHours)} (${pct(p.reducedPercent)}) under målet ${h(p.nationalHours)}. Tiden räknas mot skolans val.`;
    case "TIMPLAN_SKOLANS_VAL_OVERSPENT":
      return `Skolans val: ${h(p.takenHours)} har tagits från ämnena, ${h(p.overspentHours)} mer än de ${h(p.availableHours)} timplanen medger.`;
    case "TIMPLAN_TOTAL_BELOW_GUARANTEE":
      return `Totalt ${h(p.plannedHours)} planerat, ${h(p.deficitHours)} under den garanterade undervisningstiden ${h(p.guaranteedHours)}.`;
    default:
      // Not raised by these plans (an unpublished lydelse, an uncoded subject).
      return verdict.code;
  }
}

export const CHECKS: Record<string, LocalTimplanCheckResponse> = Object.fromEntries(
  PLANS.map((plan) => {
    const check = checkPlan(plan, BILAGA_1);
    return [
      plan.id,
      { ...check, localTimplanId: plan.id, verdicts: check.verdicts.map((verdict) => ({ ...verdict, message: describe(verdict) })) },
    ];
  }),
);
