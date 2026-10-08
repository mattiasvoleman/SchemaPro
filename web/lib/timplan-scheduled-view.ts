// The timetable's Lektionstid panel, as a view of layer 2.
//
// computeScheduledCoverage (lib/timplan-scheduled.ts, the gateway's module
// mirrored) answers per group and subject; this file decides which of those
// lines the panel shows for the groups in view, and which of them changed
// since the last answer, so the live region says only that. It computes no
// minute of its own: every figure is the module's.
//
// WHICH LINES. With exactly one group in view, all its lines — the rektor is
// looking at 7A and wants every subject. With several groups, or with none
// chosen (the whole school), only the lines that deviate: a school of 60
// groups has hundreds of matching lines, and listing them would bury the
// three that do not. The summary line counts all of them either way.
//
// WHAT "CHANGED" MEANS. A line whose scheduled, planned or parked minutes
// differ from the previous answer, or that appeared or disappeared. A pure
// move changes nothing (a week has no weekday), so it announces nothing.

import type {
  ScheduledCoverage,
  ScheduledGroupSummary,
  ScheduledLine,
  ScheduledStatus,
} from "@/lib/timplan-scheduled";

/** The Mål mode's tones (lib/requirements-target.ts), so amber means the same on both pages. */
export type ScheduleTone = "missing" | "short" | "match" | "extra";

export function scheduleTone(status: ScheduledStatus): ScheduleTone {
  switch (status) {
    case "UNSCHEDULED":
    case "UNPLANNED":
      return "missing";
    case "SHORT":
      return "short";
    case "MATCH":
      return "match";
    case "EXTRA":
      return "extra";
  }
}

export interface ScheduleDeltaLine {
  key: string;
  studentGroupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  line: ScheduledLine;
  tone: ScheduleTone;
}

export interface ScheduleDeltaGroup {
  studentGroupId: string;
  groupName: string;
  lines: ScheduleDeltaLine[];
}

export interface ScheduleDeltaView {
  /** Groups with something to show, in the module's order (classes first, then by name). */
  groups: ScheduleDeltaGroup[];
  /** Over every line of the groups in view, shown or not. */
  matching: number;
  total: number;
  /** True when every line of the groups in view is listed (one group in view). */
  allLines: boolean;
  /** Parked minutes a week in the groups in view. */
  parkedMinutes: number;
}

interface Named {
  id: string;
  name: string;
}

/**
 * The panel's lines for the groups in view; `inView` empty means every group
 * of the year, as the grid's group filter reads it.
 */
export function buildScheduleDelta(
  coverage: ScheduledCoverage,
  inView: readonly string[],
  groups: readonly Named[],
  subjects: readonly Named[],
): ScheduleDeltaView {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const subjectName = new Map(subjects.map((subject) => [subject.id, subject.name]));
  const wanted = new Set(inView);
  const summaries: ScheduledGroupSummary[] =
    wanted.size === 0 ? coverage.groups : coverage.groups.filter((g) => wanted.has(g.studentGroupId));
  const allLines = wanted.size === 1;

  let matching = 0;
  let total = 0;
  let parkedMinutes = 0;
  const shown: ScheduleDeltaGroup[] = [];
  for (const summary of summaries) {
    matching += summary.linesMatching;
    total += summary.linesTotal;
    const name = groupName.get(summary.studentGroupId) ?? summary.studentGroupId;
    const lines: ScheduleDeltaLine[] = [];
    for (const line of summary.lines) {
      parkedMinutes += line.parkedMinutesPerWeek;
      if (!allLines && line.status === "MATCH") continue;
      lines.push({
        key: `${summary.studentGroupId}:${line.subjectId}`,
        studentGroupId: summary.studentGroupId,
        groupName: name,
        subjectId: line.subjectId,
        subjectName: subjectName.get(line.subjectId) ?? line.subjectId,
        line,
        tone: scheduleTone(line.status),
      });
    }
    if (lines.length > 0) shown.push({ studentGroupId: summary.studentGroupId, groupName: name, lines });
  }
  return { groups: shown, matching, total, allLines, parkedMinutes };
}

/**
 * The lines of `next` that differ from `previous` — compared over every line
 * of the year, not only the shown ones, and returned in `next`'s order. A
 * line that left (its last lesson deleted, its post removed) is returned from
 * `previous`, after the others.
 */
export function changedLines(previous: ScheduledCoverage, next: ScheduledCoverage): {
  studentGroupId: string;
  line: ScheduledLine;
}[] {
  const before = new Map<string, ScheduledLine>();
  for (const summary of previous.groups) {
    for (const line of summary.lines) before.set(`${summary.studentGroupId}:${line.subjectId}`, line);
  }
  const changed: { studentGroupId: string; line: ScheduledLine }[] = [];
  const seen = new Set<string>();
  for (const summary of next.groups) {
    for (const line of summary.lines) {
      const key = `${summary.studentGroupId}:${line.subjectId}`;
      seen.add(key);
      const old = before.get(key);
      if (
        !old ||
        old.scheduledMinutesPerWeek !== line.scheduledMinutesPerWeek ||
        old.plannedMinutesPerWeek !== line.plannedMinutesPerWeek ||
        old.parkedMinutesPerWeek !== line.parkedMinutesPerWeek
      ) {
        changed.push({ studentGroupId: summary.studentGroupId, line });
      }
    }
  }
  for (const summary of previous.groups) {
    for (const line of summary.lines) {
      if (seen.has(`${summary.studentGroupId}:${line.subjectId}`)) continue;
      changed.push({
        studentGroupId: summary.studentGroupId,
        line: { ...line, scheduledMinutesPerWeek: 0, parkedMinutesPerWeek: 0, plannedMinutesPerWeek: 0 },
      });
    }
  }
  return changed;
}

/** A signed difference with a real minus sign, as the timplan pages write one. */
export const signedDelta = (value: number): string =>
  value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0";
