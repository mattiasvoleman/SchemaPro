import type { TeachingRequirement } from "../../../lib/types";
import type {
  PlannedCell,
  PlannedGroupSummary,
  PlannedLine,
  PlannedPupil,
  PlannedStatus,
  PlannedVerdict,
  PupilLine,
} from "../../../lib/timplan-planned";
import type { TimplanCoverageResponse } from "../../../lib/timplan-tackning";
import type { TeachingTimeCardResponse, TeachingTimeLine } from "../../../components/teaching-time-card";
import { THIS_MONDAY, YEAR_END, YEAR_START } from "./calendar";
import { GROUP_MEMBERS } from "./school-days";
import { BILAGA_1, NATIONAL_NAME, PARENT_OF } from "./timplan-national";
import {
  ALTERNATIVE_CODES,
  CREDITS,
  DECIDED_PLAN,
  PLANS,
  YEAR_TIMPLANS,
  YEAR_WEEKS,
} from "./timplan-plans";
import { GROUP_LIST, MASTER_LESSONS, REQUIREMENTS, STUDENT_LIST, SUBJECT_LIST } from "./world";

/**
 * The year's timplanstäckning, layer 1 (GET /timplan-coverage?layer=planned),
 * and each pupil's published "Undervisningstid" (GET /timplan-stages/card),
 * both from world.ts's classes, requirements and grundschema against
 * timplan-plans.ts's plans, so the figures agree with every other page.
 *
 * Layer 1 follows lib/timplan-planned.ts's rules: a line per subject (one per
 * alternative, Svenska/SvA and språkval), MET within one lesson of surplus,
 * judged through the teaching groups when they reach half the class. No pupil
 * here reads a subject from two groups, so the double-planned findings are
 * not modelled.
 */

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: string, b: string) => a.localeCompare(b, "sv");
/** Minutes → hours to the tenth. */
const hours = (minutes: number) => Math.round(minutes / 6) / 10;

const counted = new Map(SUBJECT_LIST.filter((entry) => entry.countsTowardTimplan).map((entry) => [entry.id, entry]));
const groupById = new Map(GROUP_LIST.map((entry) => [entry.id, entry]));
const subjectOrder = (a: string, b: string) => byName(counted.get(a)?.name ?? "", counted.get(b)?.name ?? "") || byCode(a, b);
const groupOrder = (a: string, b: string) => byName(groupById.get(a)?.name ?? "", groupById.get(b)?.name ?? "") || byCode(a, b);

// A row with lektionslängder is those lessons (60 + 40), otherwise lessons × minutes.
const lengthsOf = (row: TeachingRequirement) => row.lessonLengths ?? [];
const weeklyMinutes = (row: TeachingRequirement) =>
  lengthsOf(row).length > 0
    ? lengthsOf(row).reduce((sum, minutes) => sum + minutes, 0)
    : row.lessonsPerWeek * row.minutesPerLesson;
const shortestLesson = (row: TeachingRequirement) =>
  lengthsOf(row).length > 0 ? Math.min(...lengthsOf(row)) : row.minutesPerLesson;

/** A pupil's teaching groups this year: the memberships that are not their class. */
const teachingGroupsOf = (studentId: string) =>
  GROUP_MEMBERS.filter((row) => row.studentId === studentId && groupById.get(row.studentGroupId)?.kind === "TEACHING_GROUP")
    .map((row) => row.studentGroupId)
    .sort(groupOrder);

const lineKeyOf = (subjectId: string) => {
  const code = counted.get(subjectId)?.nationalCode ?? null;
  return code !== null && ALTERNATIVE_CODES.includes(code)
    ? { key: `alt:${code}`, alternativeCode: code }
    : { key: `subject:${subjectId}`, alternativeCode: null };
};

interface LineDraft {
  key: string;
  alternativeCode: string | null;
  subjectIds: Set<string>;
  target: number | null;
  week: number;
  smallestLesson: number;
}

function buildLines(targets: Map<string, number> | null, rows: TeachingRequirement[]): Map<string, LineDraft> {
  const lines = new Map<string, LineDraft>();
  const lineFor = (subjectId: string) => {
    const { key, alternativeCode } = lineKeyOf(subjectId);
    let line = lines.get(key);
    if (!line) {
      line = { key, alternativeCode, subjectIds: new Set(), target: null, week: 0, smallestLesson: Infinity };
      lines.set(key, line);
    }
    line.subjectIds.add(subjectId);
    return line;
  };
  for (const [subjectId, minutes] of targets ?? []) {
    const line = lineFor(subjectId);
    line.target = Math.max(line.target ?? 0, minutes);
  }
  for (const row of rows) {
    const line = lineFor(row.subjectId);
    line.week += weeklyMinutes(row);
    line.smallestLesson = Math.min(line.smallestLesson, shortestLesson(row));
  }
  for (const [key, line] of lines) {
    if (!(line.target !== null && line.target > 0) && line.week === 0) lines.delete(key);
  }
  return lines;
}

const firstSubject = (line: LineDraft) => [...line.subjectIds].sort(subjectOrder)[0] ?? "";
const lineOrder = (a: LineDraft, b: LineDraft) => subjectOrder(firstSubject(a), firstSubject(b)) || byCode(a.key, b.key);

// The gateway's sentences (src/timplan/timplan-planned-messages.ts), for the codes this school raises.
const min = (value: string | number | undefined) => `${Number(value ?? 0)} min/vecka`;
const grade = (value: string | number | undefined) => (Number(value) === 0 ? "förskoleklass" : `åk ${value}`);

function describe(verdict: PlannedVerdict): string {
  const p = verdict.params;
  switch (verdict.code) {
    case "TIMPLAN_YEAR_GRADE_UNATTACHED":
      return `Läsåret följer ingen lokal timplan i ${grade(p.gradeLevel)} (${p.groupNames}). Välj en under läsårets "Timplan per årskurs" för att jämföra klassernas timplansposter med den.`;
    case "TIMPLAN_ATTACHED_DRAFT":
      return `${String(p.gradeLevels).includes(",") ? "Årskurserna" : "Årskurs"} ${p.gradeLevels} följer "${p.planName}", som är ett utkast — inte beslutad. Jämförelsen gäller utkastet.`;
    case "TIMPLAN_ATTACHED_PLAN_EMPTY":
      return `Klasserna i ${grade(p.gradeLevel)} (${p.groupNames}) följer "${p.planName}", som inte ger årskursen någon tid, så de har inga mål. Välj rätt plan under läsårets "Timplan per årskurs".`;
    case "TIMPLAN_GROUP_UNPLANNED":
      return `${p.groupName}: ${p.subjectName} har inga timplansposter, och timplanen säger ${min(p.targetMinutesPerWeek)} för ${grade(p.gradeLevel)}.`;
    case "TIMPLAN_GROUP_UNDERPLANNED":
      return `${p.groupName}: ${p.subjectName} är planerat till ${min(p.plannedMinutesPerWeek)}, ${p.deficitMinutesPerWeek} under målet ${min(p.targetMinutesPerWeek)} för ${grade(p.gradeLevel)}.`;
    case "TIMPLAN_GROUP_OVERPLANNED":
      return `${p.groupName}: ${p.subjectName} är planerat till ${min(p.plannedMinutesPerWeek)}, ${p.surplusMinutesPerWeek} över målet ${min(p.targetMinutesPerWeek)} — minst en hel lektion mer än timplanen säger.`;
    case "TIMPLAN_PUPIL_UNDERPLANNED":
      return `En elev i ${p.groupName} får ${min(p.plannedMinutesPerWeek)} ${p.subjectName}, ${p.deficitMinutesPerWeek} under målet ${min(p.targetMinutesPerWeek)} för ${grade(p.gradeLevel)}.`;
    default:
      return verdict.code;
  }
}

const VERDICT_ORDER: PlannedVerdict["code"][] = [
  "TIMPLAN_YEAR_GRADE_UNATTACHED",
  "TIMPLAN_ATTACHED_DRAFT",
  "TIMPLAN_ATTACHED_PLAN_EMPTY",
  "TIMPLAN_GROUP_UNPLANNED",
  "TIMPLAN_GROUP_UNDERPLANNED",
  "TIMPLAN_GROUP_OVERPLANNED",
  "TIMPLAN_PUPIL_UNDERPLANNED",
  "TIMPLAN_PUPIL_DOUBLE_PLANNED",
];

/** Layer 1 for one läsår, as an admin reads it (pupil figures included). */
export function plannedCoverage(academicYearId: string): TimplanCoverageResponse {
  const groups = GROUP_LIST.filter((entry) => entry.academicYearId === academicYearId);
  const inYear = new Set(groups.map((entry) => entry.id));
  const planOfGrade = new Map(
    (YEAR_TIMPLANS[academicYearId] ?? []).map((row) => [row.gradeLevel, PLANS.find((plan) => plan.id === row.localTimplanId)!]),
  );
  const targetsOf = (gradeLevel: number | null) => {
    const plan = gradeLevel === null ? undefined : planOfGrade.get(gradeLevel);
    if (!plan) return null;
    return new Map(
      plan.entries
        .filter((entry) => entry.gradeLevel === gradeLevel && counted.has(entry.subjectId))
        .map((entry) => [entry.subjectId, entry.minutesPerWeek]),
    );
  };
  const rowsOf = (groupId: string) =>
    REQUIREMENTS.filter(
      (row) => row.academicYearId === academicYearId && row.studentGroupId === groupId && counted.has(row.subjectId),
    );
  const classes = groups.filter((entry) => entry.kind === "CLASS").sort((a, b) => groupOrder(a.id, b.id));
  const verdicts: PlannedVerdict[] = [];

  // Årskurser with classes and nothing attached, or attached to a plan that gives them no minutes.
  for (const level of [...new Set(classes.map((entry) => entry.gradeLevel))].sort((a, b) => (a ?? 0) - (b ?? 0))) {
    if (level === null) continue;
    const ids = classes.filter((entry) => entry.gradeLevel === level).map((entry) => entry.id);
    const named = { gradeLevel: level, groupCount: ids.length, groupNames: ids.map((id) => groupById.get(id)!.name).join(", ") };
    const plan = planOfGrade.get(level);
    if (!plan) {
      verdicts.push({ code: "TIMPLAN_YEAR_GRADE_UNATTACHED", severity: "notice", gradeLevel: level, studentGroupIds: ids, params: named });
    } else if (![...targetsOf(level)!.values()].some((minutes) => minutes > 0)) {
      verdicts.push({
        code: "TIMPLAN_ATTACHED_PLAN_EMPTY",
        severity: "notice",
        gradeLevel: level,
        localTimplanId: plan.id,
        studentGroupIds: ids,
        params: { ...named, planName: plan.name },
      });
    }
  }
  for (const plan of PLANS.filter((entry) => entry.status === "DRAFT")) {
    const levels = [...planOfGrade].filter(([, attached]) => attached.id === plan.id).map(([level]) => level).sort((a, b) => a - b);
    if (levels.length === 0) continue;
    verdicts.push({
      code: "TIMPLAN_ATTACHED_DRAFT",
      severity: "notice",
      localTimplanId: plan.id,
      gradeLevels: levels,
      params: { planName: plan.name, gradeLevels: levels.join(", ") },
    });
  }

  const summaries: PlannedGroupSummary[] = [];
  const cells: PlannedCell[] = [];
  const pupils: PlannedPupil[] = [];
  let pupilCount = 0;
  let pupilsBelow = 0;
  for (const group of classes) {
    const level = group.gradeLevel;
    const targets = targetsOf(level);
    const plan = level === null ? undefined : planOfGrade.get(level);
    const rows = rowsOf(group.id);
    const results = STUDENT_LIST.filter((pupil) => pupil.studentGroupId === group.id)
      .sort((a, b) => byCode(a.id, b.id))
      .map((pupil) => {
        const own = teachingGroupsOf(pupil.id).filter((id) => inYear.has(id));
        const reaching = [group.id, ...own].flatMap(rowsOf);
        return { pupil, own, lines: buildLines(targets, reaching), rows: reaching };
      });
    pupilCount += results.length;
    const carriers = [...new Set(results.flatMap((result) => result.own))];
    const name = (ids: string[]) => ids.map((id) => counted.get(id)?.name ?? id).join(" / ");

    const flagged = new Set<string>();
    const lines: PlannedLine[] = [];
    let targetTotal = 0;
    let withTarget = 0;
    let covered = 0;
    for (const draft of [...buildLines(targets, rows).values()].sort(lineOrder)) {
      const planned = Math.round(draft.week);
      const target = draft.target;
      const carriedBy = carriers
        .filter((id) => rowsOf(id).some((row) => lineKeyOf(row.subjectId).key === draft.key))
        .sort(groupOrder);
      const reached = results.filter((result) => result.own.some((id) => carriedBy.includes(id))).length;
      let status: PlannedStatus;
      if (target === null) status = "NO_TARGET";
      else if (planned >= target) {
        const surplus = planned - target;
        status = surplus > 0 && (target === 0 || surplus >= draft.smallestLesson) ? "OVER" : "MET";
      } else if (reached > 0 && reached * 2 >= results.length) status = "PUPILS";
      else status = planned === 0 ? "UNPLANNED" : "UNDER";

      const values = results.map((result) => Math.round(result.lines.get(draft.key)?.week ?? 0));
      const below = target === null ? 0 : values.filter((value) => value < target).length;
      const isCovered = target !== null && target > 0 ? (results.length > 0 ? below === 0 : planned >= target) : false;
      if (target !== null && target > 0) {
        withTarget++;
        if (isCovered) covered++;
      }
      if (target !== null) targetTotal += target;

      const subjectIds = [...draft.subjectIds].sort(subjectOrder);
      const sorted = [...values].sort((a, b) => a - b);
      const middle = sorted.length >> 1;
      lines.push({
        key: draft.key,
        alternativeCode: draft.alternativeCode,
        subjectIds,
        targetMinutesPerWeek: target,
        plannedMinutesPerWeek: planned,
        deltaMinutesPerWeek: target === null ? null : planned - target,
        targetHours: target === null ? null : hours(target * YEAR_WEEKS),
        plannedHours: hours(draft.week * YEAR_WEEKS),
        status,
        covered: isCovered,
        teachingGroupIds: carriedBy,
        ...(sorted.length > 0
          ? {
              pupils: {
                min: sorted[0]!,
                median: sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2),
                max: sorted[sorted.length - 1]!,
                below,
              },
            }
          : {}),
      });

      const named = {
        groupName: group.name,
        gradeLevel: level ?? "",
        subjectName: name(subjectIds),
        targetMinutesPerWeek: target ?? 0,
        plannedMinutesPerWeek: planned,
      };
      const where = { studentGroupId: group.id, subjectIds, ...(draft.alternativeCode ? { alternativeCode: draft.alternativeCode } : {}) };
      if (status === "UNPLANNED" || status === "UNDER") {
        flagged.add(draft.key);
        verdicts.push({
          code: status === "UNPLANNED" ? "TIMPLAN_GROUP_UNPLANNED" : "TIMPLAN_GROUP_UNDERPLANNED",
          severity: "warning",
          ...where,
          params: { ...named, deficitMinutesPerWeek: (target ?? 0) - planned },
        });
      } else if (status === "OVER") {
        verdicts.push({
          code: "TIMPLAN_GROUP_OVERPLANNED",
          severity: "notice",
          ...where,
          params: { ...named, surplusMinutesPerWeek: planned - (target ?? 0) },
        });
      }

      for (const subjectId of subjectIds) {
        const own = rows.filter((row) => row.subjectId === subjectId);
        const week = own.reduce((sum, row) => sum + weeklyMinutes(row), 0);
        const ownTarget = targets?.get(subjectId) ?? null;
        cells.push({
          studentGroupId: group.id,
          subjectId,
          alternativeCode: draft.alternativeCode,
          targetMinutesPerWeek: ownTarget,
          plannedMinutesPerWeek: week,
          targetHours: ownTarget === null ? null : hours(ownTarget * YEAR_WEEKS),
          plannedHours: hours(week * YEAR_WEEKS),
          requirementIds: own.map((row) => row.id),
          status,
        });
      }
    }

    // The pupils with a finding of their own: short where the class is not already flagged.
    for (const result of results) {
      const own: PupilLine[] = [];
      let isBelow = false;
      for (const draft of [...result.lines.values()].sort(lineOrder)) {
        const planned = Math.round(draft.week);
        const target = draft.target;
        const status = target === null ? "NO_TARGET" : planned < target ? "UNDER" : "MET";
        if (status !== "UNDER") continue;
        isBelow = true;
        if (flagged.has(draft.key)) continue;
        const subjectIds = [...draft.subjectIds].sort(subjectOrder);
        verdicts.push({
          code: "TIMPLAN_PUPIL_UNDERPLANNED",
          severity: "warning",
          pupilId: result.pupil.id,
          studentGroupId: group.id,
          subjectIds,
          ...(draft.alternativeCode ? { alternativeCode: draft.alternativeCode } : {}),
          params: {
            groupName: group.name,
            gradeLevel: level ?? "",
            subjectName: name(subjectIds),
            targetMinutesPerWeek: target!,
            plannedMinutesPerWeek: planned,
            deficitMinutesPerWeek: target! - planned,
          },
        });
        own.push({
          key: draft.key,
          alternativeCode: draft.alternativeCode,
          subjectIds,
          targetMinutesPerWeek: target,
          plannedMinutesPerWeek: planned,
          status,
          sources: result.rows
            .filter((row) => subjectIds.includes(row.subjectId))
            .map((row) => ({ studentGroupId: row.studentGroupId, subjectId: row.subjectId, minutesPerWeek: weeklyMinutes(row) })),
          doublePlannedSubjectIds: [],
          alternativeSubjectIds: [],
        });
      }
      if (isBelow) pupilsBelow++;
      if (own.length > 0) pupils.push({ pupilId: result.pupil.id, homeGroupId: group.id, gradeLevel: level, lines: own });
    }

    const week = rows.reduce((sum, row) => sum + weeklyMinutes(row), 0);
    summaries.push({
      studentGroupId: group.id,
      gradeLevel: level,
      localTimplanId: plan?.id ?? null,
      planStatus: plan?.status ?? null,
      plannedMinutesPerWeek: week,
      targetMinutesPerWeek: targetTotal,
      plannedHours: hours(week * YEAR_WEEKS),
      targetHours: hours(targetTotal * YEAR_WEEKS),
      linesWithTarget: withTarget,
      linesCovered: covered,
      pupilCount: results.length,
      lines,
    });
  }

  verdicts.sort((a, b) => VERDICT_ORDER.indexOf(a.code) - VERDICT_ORDER.indexOf(b.code));
  return {
    academicYearId,
    layer: "planned",
    pupilLevel: true,
    groups: summaries,
    cells,
    pupils,
    pupilCount,
    pupilsBelowTarget: pupilsBelow,
    pupilsOutsideClasses: STUDENT_LIST.filter((pupil) => !classes.some((entry) => entry.id === pupil.studentGroupId)).length,
    verdicts: verdicts.map((verdict) => ({ ...verdict, message: describe(verdict) })),
  };
}

// --- Undervisningstid: the statement the school published -----------------------

/*
 * Published this Monday, for the högstadium every pupil here is in. The class
 * history began with this läsår, so a pupil in åk 7 has the whole stage
 * (recorded, then planned ahead) and is judged against bilaga 1, while one in
 * åk 8 or 9 has years SchemaPro never saw and is not.
 */
const AS_OF = THIS_MONDAY < YEAR_START ? YEAR_START : THIS_MONDAY > YEAR_END ? YEAR_END : THIS_MONDAY;
// Eight weeks into the läsår, every week the suite runs: "Hittills" is in the
// accessibility-tree baselines, and counted from YEAR_START it grew weekly.
const HELD_WEEKS = 8;
const HOG = [7, 8, 9];

const topCodeOf = (subjectId: string | null) => {
  const entry = subjectId === null ? undefined : counted.get(subjectId);
  if (!entry?.nationalCode) return null;
  return PARENT_OF.get(entry.nationalCode) ?? entry.nationalCode;
};
const lessonMinutes = (start: string, end: string) => {
  const [startHours, startMinutes] = start.split(":").map(Number);
  const [endHours, endMinutes] = end.split(":").map(Number);
  return endHours! * 60 + endMinutes! - (startHours! * 60 + startMinutes!);
};
const tenth = (value: number) => Math.round(value * 10) / 10;

export function teachingTimeCard(studentId: string): TeachingTimeCardResponse {
  const pupil = STUDENT_LIST.find((entry) => entry.id === studentId);
  const home = pupil ? groupById.get(pupil.studentGroupId ?? "") : undefined;
  const level = home?.kind === "CLASS" ? home.gradeLevel : null;
  if (!pupil || !home || level === null || !HOG.includes(level)) return { statement: null };

  const groupIds = [home.id, ...teachingGroupsOf(pupil.id)];
  const rows = REQUIREMENTS.filter((row) => groupIds.includes(row.studentGroupId));
  const lessons = MASTER_LESSONS.filter(
    (lesson) =>
      !lesson.isParked &&
      (groupIds.includes(lesson.studentGroupId) ||
        lesson.extraGroupIds.some((id) => groupIds.includes(id)) ||
        lesson.studentIds.includes(pupil.id)),
  );
  const credits = CREDITS.filter(
    (credit) =>
      credit.studentGroupId === null
        ? (credit.minGradeLevel ?? 0) <= level && level <= (credit.maxGradeLevel ?? 99)
        : groupIds.includes(credit.studentGroupId),
  );
  const unrecordedGrades = HOG.filter((entry) => entry < level);
  const plannedGrades = HOG.filter((entry) => entry > level);
  const complete = unrecordedGrades.length === 0;

  const lines: TeachingTimeLine[] = BILAGA_1.entries
    .filter((entry) => entry.stage === "HOG" && !PARENT_OF.get(entry.subjectCode))
    .map((entry) => {
      const code = entry.subjectCode;
      const plannedWeek = rows.filter((row) => topCodeOf(row.subjectId) === code).reduce((sum, row) => sum + weeklyMinutes(row), 0);
      const heldWeek = lessons
        .filter((lesson) => topCodeOf(lesson.subjectId) === code)
        .reduce((sum, lesson) => sum + lessonMinutes(lesson.startTime, lesson.endTime), 0);
      const ahead = plannedGrades.reduce(
        (sum, gradeLevel) =>
          sum +
          DECIDED_PLAN.entries
            .filter((row) => row.gradeLevel === gradeLevel && topCodeOf(row.subjectId) === code)
            .reduce((most, row) => (ALTERNATIVE_CODES.includes(code) ? Math.max(most, row.minutesPerWeek) : most + row.minutesPerWeek), 0),
        0,
      );
      const credited = (past: boolean) =>
        credits
          .filter((credit) => topCodeOf(credit.subjectId) === code && (credit.date < AS_OF) === past)
          .reduce((sum, credit) => sum + credit.minutes, 0);
      const plannedHours = tenth(((plannedWeek + ahead) * YEAR_WEEKS) / 60);
      const outcomeHours = tenth((heldWeek * HELD_WEEKS + credited(true)) / 60);
      const projectedHours = tenth(
        outcomeHours + (heldWeek * (YEAR_WEEKS - HELD_WEEKS) + credited(false) + ahead * YEAR_WEEKS) / 60,
      );
      const judge = (figure: number) => {
        if (!complete) return "UNRECORDED";
        const short = entry.hours - figure;
        if (short < 1) return "MET";
        return !entry.protectedFromReduction && short * 100 <= (BILAGA_1.reductionCapPercent ?? 0) * entry.hours
          ? "BELOW_WITHIN_CAP"
          : "BELOW";
      };
      return {
        subjectCode: code,
        subjectName: NATIONAL_NAME.get(code) ?? code,
        nationalHours: entry.hours,
        plannedHours,
        outcomeHours,
        projectedHours,
        status: judge(plannedHours),
        projectedStatus: judge(projectedHours),
      };
    });

  return {
    statement: {
      studentId: pupil.id,
      academicYearId: home.academicYearId,
      asOfDate: AS_OF,
      stages: [
        {
          stage: "HOG",
          versionCode: BILAGA_1.code,
          distributionPublished: BILAGA_1.entries.length > 0,
          gradesFrom: 7,
          gradesTo: 9,
          complete,
          recordedFrom: YEAR_START,
          plannedGrades,
          unrecordedGrades,
          unplannedGrades: [],
          backfilled: false,
          historyFrom: null,
          lines,
        },
      ],
    },
  };
}
