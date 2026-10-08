import { describe, expect, it } from "vitest";
import type { ScheduledCoverage, ScheduledLine } from "@/lib/timplan-scheduled";
import { buildScheduleDelta, changedLines, scheduleTone, signedDelta } from "@/lib/timplan-scheduled-view";

const line = (subjectId: string, planned: number, scheduled: number, parked = 0): ScheduledLine => ({
  subjectId,
  plannedMinutesPerWeek: planned,
  scheduledMinutesPerWeek: scheduled,
  parkedMinutesPerWeek: parked,
  deltaMinutesPerWeek: scheduled - planned,
  percent: planned > 0 ? Math.round((100 * scheduled) / planned) : null,
  status:
    planned > 0 && scheduled === 0
      ? "UNSCHEDULED"
      : planned === 0
        ? "UNPLANNED"
        : scheduled < planned
          ? "SHORT"
          : scheduled > planned
            ? "EXTRA"
            : "MATCH",
  requirementIds: [],
  masterLessonIds: [],
});

const coverage = (groups: Record<string, ScheduledLine[]>): ScheduledCoverage => ({
  pupilLevel: false,
  groups: Object.entries(groups).map(([id, lines]) => ({
    studentGroupId: id,
    kind: "CLASS",
    gradeLevel: 7,
    plannedMinutesPerWeek: 0,
    scheduledMinutesPerWeek: 0,
    linesMatching: lines.filter((l) => l.status === "MATCH").length,
    linesTotal: lines.length,
    pupilCount: 0,
    lines,
  })),
  pupils: null,
  pupilCount: 0,
  pupilsBelowPlanned: null,
  lessonCount: 0,
  verdicts: [],
});

const GROUPS = [
  { id: "a", name: "7A" },
  { id: "b", name: "7B" },
];
const SUBJECTS = [
  { id: "ma", name: "Matematik" },
  { id: "sv", name: "Svenska" },
];

describe("buildScheduleDelta", () => {
  const year = coverage({ a: [line("ma", 180, 180), line("sv", 120, 60, 60)], b: [line("ma", 180, 180)] });

  it("shows only deviating lines for the whole school, and counts every line", () => {
    const view = buildScheduleDelta(year, [], GROUPS, SUBJECTS);
    expect(view.groups.map((g) => [g.groupName, g.lines.map((l) => l.subjectName)])).toEqual([["7A", ["Svenska"]]]);
    expect([view.matching, view.total, view.parkedMinutes, view.allLines]).toEqual([2, 3, 60, false]);
    expect(view.groups[0]!.lines[0]!.tone).toBe("short");
  });

  it("shows every line of the one group in view", () => {
    const view = buildScheduleDelta(year, ["b"], GROUPS, SUBJECTS);
    expect(view.groups.map((g) => g.lines.map((l) => l.line.status))).toEqual([["MATCH"]]);
    expect([view.matching, view.total, view.allLines]).toEqual([1, 1, true]);
  });

  it("shows nothing for chosen groups that all match, and names an unknown subject by its id", () => {
    expect(buildScheduleDelta(year, ["b", "a"], GROUPS, []).groups[0]!.lines[0]!.subjectName).toBe("sv");
    expect(buildScheduleDelta(year, ["b", "zz"], GROUPS, SUBJECTS).groups).toEqual([]);
  });
});

describe("changedLines", () => {
  it("names a line whose minutes moved, one that appeared and one that left, and nothing else", () => {
    const before = coverage({ a: [line("ma", 180, 180), line("sv", 0, 60)] });
    const after = coverage({ a: [line("ma", 180, 175)], b: [line("ma", 180, 0)] });
    expect(changedLines(before, after).map((c) => [c.studentGroupId, c.line.subjectId, c.line.scheduledMinutesPerWeek])).toEqual([
      ["a", "ma", 175],
      ["b", "ma", 0],
      ["a", "sv", 0],
    ]);
    expect(changedLines(after, after)).toEqual([]);
  });
});

describe("tones and signs", () => {
  it("paints missing posts or lessons as the Mål mode paints unplanned, and writes a real minus", () => {
    expect(["UNSCHEDULED", "UNPLANNED", "SHORT", "MATCH", "EXTRA"].map((s) => scheduleTone(s as never))).toEqual([
      "missing",
      "missing",
      "short",
      "match",
      "extra",
    ]);
    expect([signedDelta(-60), signedDelta(5), signedDelta(0)]).toEqual(["−60", "+5", "0"]);
  });
});
