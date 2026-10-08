// Schemalagt mot planerat, as the browser computes it.
//
// A MIRROR OF src/common/timplan-scheduled.ts, not a second opinion on it. The
// gateway answers GET /timplan-coverage?layer=scheduled from that file; this
// copy exists so the timetable's Lektionstid panel can repaint "schemalagt /
// planerat" in the render a resize, a park or a delete lands in, without a
// round trip. Both copies replay
// src/common/__fixtures__/timplan-scheduled-cases.json (generated from the
// gateway copy), asserted by timplan-scheduled.contract.spec.ts there and
// timplan-scheduled.contract.test.ts here. A case is added for both sides at
// once; the code is fixed, never the fixture.
//
// What the numbers mean — both sides at standardWeekWeight at the judged
// grade, each lesson at its own duration, parked lessons apart, a group line
// counting owned and extra-attended lessons and reading no roster, a pupil
// listed only for a shortfall of their own, statistics over the pupils' delta
// — is argued in the gateway file's header and not repeated here. The imports
// are lesson-lengths, teacher-load's standardWeekWeight and types only: P2's
// planned module is not pulled into the panel's chunk. The body below is that
// file with the quotes this package's style uses; keep it that way, so a diff
// of the two shows only the header.

import { standardWeekWeight } from "@/lib/teacher-load";
import { shortestLessonOf, weeklyMinutesOf } from "@/lib/lesson-lengths";
import type { ClosedRange, YearBounds } from "@/lib/teaching-hours";
import type {
  PlannedGroup,
  PlannedPupilInput,
  PlannedRequirement,
  PlannedSubject,
} from "@/lib/timplan-planned";

export type ScheduledStatus = "MATCH" | "SHORT" | "EXTRA" | "UNSCHEDULED" | "UNPLANNED";

export type ScheduledVerdictCode =
  | "TIMPLAN_SCHEDULE_NONE"
  | "TIMPLAN_SCHEDULE_UNSCHEDULED"
  | "TIMPLAN_SCHEDULE_SHORT"
  | "TIMPLAN_SCHEDULE_PARKED"
  | "TIMPLAN_SCHEDULE_EXTRA"
  | "TIMPLAN_SCHEDULE_UNPLANNED"
  | "TIMPLAN_PUPIL_SCHEDULE_SHORT";

export interface ScheduledLessonInput {
  id: string;
  studentGroupId: string;
  subjectId: string;
  /** 'HH:MM' or 'HH:MM:SS' — the API's and the board's form alike. */
  startTime: string;
  endTime: string;
  recurrence?: "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS" | null;
  startDate?: string | null;
  endDate?: string | null;
  isParked: boolean;
  extraGroupIds: readonly string[];
  studentIds: readonly string[];
}

export interface ScheduledCoverageInput {
  year: YearBounds;
  closures: ClosedRange[];
  subjects: PlannedSubject[];
  groups: PlannedGroup[];
  requirements: PlannedRequirement[];
  lessons: ScheduledLessonInput[];
  /** The board passes [] — group lines read no roster. */
  pupils: PlannedPupilInput[];
  /** False for a teacher's read and for the board: no pupil figure leaves. */
  includePupils: boolean;
  /**
   * The drill-down: every pupil of this group (home pupils of a class,
   * members of a teaching group) is listed with every line, not only those
   * with a finding of their own. Ignored without includePupils.
   */
  drillGroupId?: string | null;
}

export interface ScheduledVerdict {
  code: ScheduledVerdictCode;
  severity: "notice" | "warning";
  studentGroupId?: string;
  subjectIds?: string[];
  pupilId?: string;
  params: Record<string, string | number>;
}

/** Over the pupils' delta (their scheduled − their planned). */
export interface DeltaStats {
  min: number;
  median: number;
  max: number;
  /** Pupils with a negative delta. */
  below: number;
}

export interface ScheduledLine {
  subjectId: string;
  plannedMinutesPerWeek: number;
  scheduledMinutesPerWeek: number;
  parkedMinutesPerWeek: number;
  deltaMinutesPerWeek: number;
  /** round(100 · scheduled / planned); null when nothing is planned. */
  percent: number | null;
  status: ScheduledStatus;
  requirementIds: string[];
  /** The non-parked lessons counted, then the parked ones. */
  masterLessonIds: string[];
  pupils?: DeltaStats;
}

export interface ScheduledGroupSummary {
  studentGroupId: string;
  kind: "CLASS" | "TEACHING_GROUP";
  gradeLevel: number | null;
  plannedMinutesPerWeek: number;
  scheduledMinutesPerWeek: number;
  linesMatching: number;
  linesTotal: number;
  pupilCount: number;
  lines: ScheduledLine[];
}

export interface ScheduledPupilSource {
  /** The group the lessons reach the pupil through; null when only named. */
  studentGroupId: string | null;
  masterLessonIds: string[];
  minutesPerWeek: number;
}

export interface ScheduledPupilLine {
  subjectId: string;
  plannedMinutesPerWeek: number;
  scheduledMinutesPerWeek: number;
  groupDeficitMinutesPerWeek: number;
  sources: ScheduledPupilSource[];
}

export interface ScheduledPupil {
  pupilId: string;
  homeGroupId: string;
  gradeLevel: number | null;
  lines: ScheduledPupilLine[];
}

export interface ScheduledCoverage {
  pupilLevel: boolean;
  groups: ScheduledGroupSummary[];
  /** Pupils with a finding of their own; with drillGroupId, every pupil of it. */
  pupils: ScheduledPupil[] | null;
  pupilCount: number;
  pupilsBelowPlanned: number | null;
  /** Non-parked lessons of counted subjects and this year's groups. */
  lessonCount: number;
  verdicts: ScheduledVerdict[];
}

const VERDICT_ORDER: Record<ScheduledVerdictCode, number> = {
  TIMPLAN_SCHEDULE_NONE: 0,
  TIMPLAN_SCHEDULE_UNSCHEDULED: 1,
  TIMPLAN_SCHEDULE_SHORT: 2,
  TIMPLAN_SCHEDULE_PARKED: 3,
  TIMPLAN_SCHEDULE_EXTRA: 4,
  TIMPLAN_SCHEDULE_UNPLANNED: 5,
  TIMPLAN_PUPIL_SCHEDULE_SHORT: 6,
};

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: string, b: string): number => a.localeCompare(b, "sv");

/** A lesson's minutes, end − start on the wall clock; 0 for a malformed or reversed pair. */
export function lessonMinutes(lesson: Pick<ScheduledLessonInput, "startTime" | "endTime">): number {
  const clock = (value: string): number | null => {
    const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const start = clock(lesson.startTime);
  const end = clock(lesson.endTime);
  return start === null || end === null || end <= start ? 0 : end - start;
}

/** min / median / max / below over whole-minute deltas; null for none. */
function statsOf(values: number[]): DeltaStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return {
    min: sorted[0]!,
    median:
      sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2),
    max: sorted[sorted.length - 1]!,
    below: values.filter((value) => value < 0).length,
  };
}

interface LineDraft {
  subjectId: string;
  planned: number;
  scheduled: number;
  parked: number;
  requirementIds: string[];
  lessonIds: string[];
  parkedIds: string[];
}

export function computeScheduledCoverage(input: ScheduledCoverageInput): ScheduledCoverage {
  const { year, closures } = input;
  const subjects = new Map(input.subjects.filter((s) => s.countsTowardTimplan).map((s) => [s.id, s]));
  const subjectOrder = (a: string, b: string): number =>
    byName(subjects.get(a)?.name ?? "", subjects.get(b)?.name ?? "") || byCode(a, b);
  const groupsById = new Map(input.groups.map((g) => [g.id, g]));
  const groupOrder = (a: string, b: string): number =>
    byName(groupsById.get(a)?.name ?? "", groupsById.get(b)?.name ?? "") || byCode(a, b);
  const gradeOfGroup = (group: PlannedGroup): number | null =>
    group.kind === "CLASS" ? group.gradeLevel : null;

  // Weights, cached per (row or lesson, grade): a board refetch re-runs this
  // over every lesson, and a dated window's teaching weeks walk the year.
  const weights = new Map<string, number>();
  const weightOf = (
    key: string,
    period: Pick<ScheduledLessonInput, "recurrence" | "startDate" | "endDate">,
    grade: number | null,
  ): number => {
    const cacheKey = `${key}:${grade}`;
    let weight = weights.get(cacheKey);
    if (weight === undefined) {
      weight = standardWeekWeight(
        {
          recurrence: period.recurrence ?? "ALL_WEEKS",
          startDate: period.startDate ?? null,
          endDate: period.endDate ?? null,
          gradeSpan: grade === null ? null : { min: grade, max: grade },
        },
        year,
        closures,
      );
      weights.set(cacheKey, weight);
    }
    return weight;
  };
  const rowWeek = (row: PlannedRequirement, grade: number | null): number =>
    weeklyMinutesOf(row) * weightOf(`r:${row.id}`, row, grade);
  const rowLesson = (row: PlannedRequirement, grade: number | null): number =>
    shortestLessonOf(row) * weightOf(`r:${row.id}`, row, grade);
  const lessonWeek = (lesson: ScheduledLessonInput, grade: number | null): number =>
    lessonMinutes(lesson) * weightOf(`l:${lesson.id}`, lesson, grade);

  // The year's counted rows and lessons, indexed by every group they reach.
  const rowsByGroup = new Map<string, PlannedRequirement[]>();
  for (const row of input.requirements) {
    if (!subjects.has(row.subjectId) || !groupsById.has(row.studentGroupId)) continue;
    const list = rowsByGroup.get(row.studentGroupId) ?? [];
    list.push(row);
    rowsByGroup.set(row.studentGroupId, list);
  }
  const lessons = input.lessons.filter((l) => subjects.has(l.subjectId) && groupsById.has(l.studentGroupId));
  const lessonsByGroup = new Map<string, ScheduledLessonInput[]>();
  const lessonsByPupil = new Map<string, ScheduledLessonInput[]>();
  for (const lesson of lessons) {
    for (const groupId of new Set([lesson.studentGroupId, ...lesson.extraGroupIds])) {
      if (!groupsById.has(groupId)) continue;
      const list = lessonsByGroup.get(groupId) ?? [];
      list.push(lesson);
      lessonsByGroup.set(groupId, list);
    }
    for (const pupilId of new Set(lesson.studentIds)) {
      const list = lessonsByPupil.get(pupilId) ?? [];
      list.push(lesson);
      lessonsByPupil.set(pupilId, list);
    }
  }
  const lessonCount = lessons.filter((l) => !l.isParked).length;

  // ---- Group lines.
  const linesOf = new Map<string, Map<string, LineDraft>>();
  for (const group of input.groups) {
    const grade = gradeOfGroup(group);
    const drafts = new Map<string, LineDraft>();
    const draftFor = (subjectId: string): LineDraft => {
      let draft = drafts.get(subjectId);
      if (!draft) {
        draft = { subjectId, planned: 0, scheduled: 0, parked: 0, requirementIds: [], lessonIds: [], parkedIds: [] };
        drafts.set(subjectId, draft);
      }
      return draft;
    };
    for (const row of rowsByGroup.get(group.id) ?? []) {
      const draft = draftFor(row.subjectId);
      draft.planned += rowWeek(row, grade);
      draft.requirementIds.push(row.id);
    }
    for (const lesson of lessonsByGroup.get(group.id) ?? []) {
      const draft = draftFor(lesson.subjectId);
      if (lesson.isParked) {
        draft.parked += lessonWeek(lesson, grade);
        draft.parkedIds.push(lesson.id);
      } else {
        draft.scheduled += lessonWeek(lesson, grade);
        draft.lessonIds.push(lesson.id);
      }
    }
    linesOf.set(group.id, drafts);
  }

  const statusOf = (planned: number, scheduled: number, hasPost: boolean): ScheduledStatus => {
    if (planned > 0 && scheduled === 0) return "UNSCHEDULED";
    if (planned === 0 && scheduled > 0 && !hasPost) return "UNPLANNED";
    if (scheduled < planned) return "SHORT";
    if (scheduled > planned) return "EXTRA";
    return "MATCH";
  };
  /** A group line's whole-minute deficit, for a pupil's groupDeficit. */
  const groupDeficit = (groupId: string, subjectId: string): number => {
    const draft = linesOf.get(groupId)?.get(subjectId);
    if (!draft) return 0;
    return Math.max(0, Math.round(draft.planned) - Math.round(draft.scheduled));
  };

  // ---- Pupils, computed always when there are any: their statistics are a line's.
  const classIds = new Set(input.groups.filter((g) => g.kind === "CLASS").map((g) => g.id));
  interface PupilLineDraft {
    planned: number;
    scheduled: number;
    smallestLesson: number;
    sources: Map<string, { lessonIds: string[]; minutes: number }>;
    /** Groups whose line reaches the pupil in this subject. */
    reachedBy: Set<string>;
  }
  interface PupilResult {
    pupil: PlannedPupilInput;
    homeGroupId: string;
    grade: number | null;
    groupIds: string[];
    lines: Map<string, PupilLineDraft>;
  }
  const results: PupilResult[] = [];
  const pupilsByGroup = new Map<string, PupilResult[]>();
  for (const pupil of [...input.pupils].sort((a, b) => byCode(a.id, b.id))) {
    if (pupil.homeGroupId === null || !classIds.has(pupil.homeGroupId)) continue;
    const home = groupsById.get(pupil.homeGroupId)!;
    const grade = home.gradeLevel;
    const teaching = [...new Set(pupil.groupIds)].filter((id) => groupsById.get(id)?.kind === "TEACHING_GROUP");
    const groupIds = [home.id, ...teaching];
    const own = new Set(groupIds);
    const lines = new Map<string, PupilLineDraft>();
    const lineFor = (subjectId: string): PupilLineDraft => {
      let line = lines.get(subjectId);
      if (!line) {
        line = { planned: 0, scheduled: 0, smallestLesson: Infinity, sources: new Map(), reachedBy: new Set() };
        lines.set(subjectId, line);
      }
      return line;
    };
    for (const groupId of groupIds) {
      for (const row of rowsByGroup.get(groupId) ?? []) {
        const line = lineFor(row.subjectId);
        line.planned += rowWeek(row, grade);
        const lesson = rowLesson(row, grade);
        if (lesson > 0) line.smallestLesson = Math.min(line.smallestLesson, lesson);
        line.reachedBy.add(groupId);
      }
    }
    const seen = new Set<string>();
    const reaching = [
      ...groupIds.flatMap((id) => lessonsByGroup.get(id) ?? []),
      ...(lessonsByPupil.get(pupil.id) ?? []),
    ];
    for (const lesson of reaching) {
      if (lesson.isParked || seen.has(lesson.id)) continue;
      seen.add(lesson.id);
      const line = lineFor(lesson.subjectId);
      const minutes = lessonWeek(lesson, grade);
      line.scheduled += minutes;
      // Through the owner when it is one of the pupil's groups, else the
      // first of their groups it names as an extra, else by name alone.
      const via = own.has(lesson.studentGroupId)
        ? lesson.studentGroupId
        : (lesson.extraGroupIds.find((id) => own.has(id)) ?? null);
      const key = via ?? "";
      const source = line.sources.get(key) ?? { lessonIds: [], minutes: 0 };
      source.lessonIds.push(lesson.id);
      source.minutes += minutes;
      line.sources.set(key, source);
      line.reachedBy.add(lesson.studentGroupId);
      for (const id of lesson.extraGroupIds) if (own.has(id)) line.reachedBy.add(id);
    }
    const result: PupilResult = { pupil, homeGroupId: home.id, grade, groupIds, lines };
    results.push(result);
    for (const groupId of groupIds) {
      const list = pupilsByGroup.get(groupId) ?? [];
      list.push(result);
      pupilsByGroup.set(groupId, list);
    }
  }

  const verdicts: ScheduledVerdict[] = [];
  const subjectName = (id: string): string => subjects.get(id)?.name ?? id;
  const noSchedule = lessons.length === 0;
  const plannedAnything = [...linesOf.values()].some((lines) =>
    [...lines.values()].some((draft) => Math.round(draft.planned) > 0),
  );
  if (noSchedule && plannedAnything) {
    verdicts.push({ code: "TIMPLAN_SCHEDULE_NONE", severity: "notice", params: {} });
  }

  // ---- Group summaries and their verdicts.
  const summaries: ScheduledGroupSummary[] = [];
  const orderedGroups = [...input.groups].sort(
    (a, b) => (a.kind === b.kind ? 0 : a.kind === "CLASS" ? -1 : 1) || groupOrder(a.id, b.id),
  );
  for (const group of orderedGroups) {
    const drafts = [...linesOf.get(group.id)!.values()]
      .filter(
        (draft) =>
          Math.round(draft.planned) > 0 ||
          Math.round(draft.scheduled) > 0 ||
          Math.round(draft.parked) > 0 ||
          draft.requirementIds.length > 0,
      )
      .sort((a, b) => subjectOrder(a.subjectId, b.subjectId));
    if (group.kind === "TEACHING_GROUP" && drafts.length === 0) continue;
    const members = pupilsByGroup.get(group.id) ?? [];
    // A class's statistics are over its home pupils, a teaching group's over its members.
    const statPupils = group.kind === "CLASS" ? members.filter((r) => r.homeGroupId === group.id) : members;
    let totalPlanned = 0;
    let totalScheduled = 0;
    let matching = 0;
    const lines: ScheduledLine[] = [];
    for (const draft of drafts) {
      const planned = Math.round(draft.planned);
      const scheduled = Math.round(draft.scheduled);
      const parked = Math.round(draft.parked);
      const status = statusOf(planned, scheduled, draft.requirementIds.length > 0);
      totalPlanned += draft.planned;
      totalScheduled += draft.scheduled;
      if (status === "MATCH") matching += 1;
      const line: ScheduledLine = {
        subjectId: draft.subjectId,
        plannedMinutesPerWeek: planned,
        scheduledMinutesPerWeek: scheduled,
        parkedMinutesPerWeek: parked,
        deltaMinutesPerWeek: scheduled - planned,
        percent: planned > 0 ? Math.round((100 * scheduled) / planned) : null,
        status,
        requirementIds: [...draft.requirementIds],
        masterLessonIds: [...draft.lessonIds, ...draft.parkedIds],
      };
      if (input.includePupils) {
        const stats = statsOf(
          statPupils.map((result) => {
            const own = result.lines.get(draft.subjectId);
            return own ? Math.round(own.scheduled) - Math.round(own.planned) : 0;
          }),
        );
        if (stats) line.pupils = stats;
      }
      lines.push(line);

      if (noSchedule) continue;
      const named = {
        groupName: group.name,
        subjectName: subjectName(draft.subjectId),
        plannedMinutesPerWeek: planned,
        scheduledMinutesPerWeek: scheduled,
        deltaMinutesPerWeek: scheduled - planned,
        parkedMinutesPerWeek: parked,
      };
      const where = { studentGroupId: group.id, subjectIds: [draft.subjectId] };
      if (status === "SHORT" || status === "UNSCHEDULED") {
        // Short only because of the tray: the lessons exist, set aside.
        const parkedCovers = parked > 0 && scheduled + parked >= planned;
        verdicts.push({
          code: parkedCovers
            ? "TIMPLAN_SCHEDULE_PARKED"
            : status === "SHORT"
              ? "TIMPLAN_SCHEDULE_SHORT"
              : "TIMPLAN_SCHEDULE_UNSCHEDULED",
          severity: parkedCovers ? "notice" : "warning",
          ...where,
          params: named,
        });
      } else if (status === "EXTRA") {
        verdicts.push({ code: "TIMPLAN_SCHEDULE_EXTRA", severity: "notice", ...where, params: named });
      } else if (status === "UNPLANNED") {
        verdicts.push({ code: "TIMPLAN_SCHEDULE_UNPLANNED", severity: "notice", ...where, params: named });
      }
    }
    summaries.push({
      studentGroupId: group.id,
      kind: group.kind,
      gradeLevel: group.gradeLevel,
      plannedMinutesPerWeek: Math.round(totalPlanned),
      scheduledMinutesPerWeek: Math.round(totalScheduled),
      linesMatching: matching,
      linesTotal: lines.length,
      pupilCount: statPupils.length,
      lines,
    });
  }

  // ---- Pupils: their own findings, the count below, and the drill-down.
  const listed: ScheduledPupil[] = [];
  let pupilsBelow = 0;
  const drill = input.includePupils ? (input.drillGroupId ?? null) : null;
  for (const result of results) {
    const home = groupsById.get(result.homeGroupId)!;
    let below = false;
    const lines: ScheduledPupilLine[] = [];
    const drilled = drill !== null && result.groupIds.includes(drill);
    for (const subjectId of [...result.lines.keys()].sort(subjectOrder)) {
      const line = result.lines.get(subjectId)!;
      const planned = Math.round(line.planned);
      const scheduled = Math.round(line.scheduled);
      const deficit = Math.max(0, planned - scheduled);
      const groupsDeficit = [...line.reachedBy].reduce((sum, id) => sum + groupDeficit(id, subjectId), 0);
      if (deficit > 0) below = true;
      const ownFinding =
        !noSchedule &&
        deficit > 0 &&
        Number.isFinite(line.smallestLesson) &&
        deficit - groupsDeficit >= Math.round(line.smallestLesson);
      if (ownFinding) {
        verdicts.push({
          code: "TIMPLAN_PUPIL_SCHEDULE_SHORT",
          severity: "warning",
          pupilId: result.pupil.id,
          studentGroupId: home.id,
          subjectIds: [subjectId],
          params: {
            groupName: home.name,
            subjectName: subjectName(subjectId),
            plannedMinutesPerWeek: planned,
            scheduledMinutesPerWeek: scheduled,
            deficitMinutesPerWeek: deficit,
            groupDeficitMinutesPerWeek: groupsDeficit,
          },
        });
      }
      if (!ownFinding && !drilled) continue;
      if (planned === 0 && scheduled === 0) continue;
      lines.push({
        subjectId,
        plannedMinutesPerWeek: planned,
        scheduledMinutesPerWeek: scheduled,
        groupDeficitMinutesPerWeek: groupsDeficit,
        sources: [...line.sources.entries()]
          .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : groupOrder(a, b)))
          .map(([key, source]) => ({
            studentGroupId: key === "" ? null : key,
            masterLessonIds: [...source.lessonIds].sort(byCode),
            minutesPerWeek: Math.round(source.minutes),
          })),
      });
    }
    if (below) pupilsBelow += 1;
    if (lines.length > 0 || drilled) {
      listed.push({ pupilId: result.pupil.id, homeGroupId: home.id, gradeLevel: result.grade, lines });
    }
  }

  verdicts.sort((a, b) => VERDICT_ORDER[a.code] - VERDICT_ORDER[b.code]);
  return {
    pupilLevel: input.includePupils,
    groups: summaries,
    pupils: input.includePupils ? listed : null,
    pupilCount: results.length,
    pupilsBelowPlanned: input.includePupils ? pupilsBelow : null,
    lessonCount,
    verdicts: input.includePupils ? verdicts : verdicts.filter((verdict) => verdict.pupilId === undefined),
  };
}
