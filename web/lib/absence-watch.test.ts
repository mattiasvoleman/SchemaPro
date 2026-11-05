import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ABSENCE_WATCH_BASES,
  ABSENCE_WATCH_CADENCES,
  ABSENCE_WATCH_GROUPS,
  ABSENCE_WATCH_KINDS,
  CONSECUTIVE_DAYS,
  FINDINGS_LIMIT,
  LIMIT_EXISTS,
  PERCENT,
  RECENT_DAYS,
  WINDOW_DAYS,
  emptyLimitForm,
  figureErrors,
  figuresOfForm,
  formOfLimit,
  measuredPercent,
  openFirst,
  pupilsIn,
  wholeNumber,
  type LimitForm,
} from "./absence-watch";

/**
 * The web's copy of the gateway's vocabulary and bounds. The gateway's file
 * (src/absence-watch/absence-watch.ts, root of the DTOs) and the service's
 * conflict code are read as text, because the web cannot import them, and the
 * two must say the same: a bound that differs is a form that accepts what the
 * gateway refuses, or one that refuses what it would take.
 */
const GATEWAY = readFileSync(join(__dirname, "..", "..", "src", "absence-watch", "absence-watch.ts"), "utf8");
const SERVICE = readFileSync(join(__dirname, "..", "..", "src", "absence-watch", "absence-watch.service.ts"), "utf8");

const listOf = (name: string): string[] => {
  const line = new RegExp(`export const ${name}[^=]*= \\[([^\\]]*)\\]`).exec(GATEWAY)?.[1] ?? "";
  return [...line.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
};
const boundsOf = (name: string): { min: number; max: number } => {
  const found = new RegExp(`export const ${name} = \\{ min: (\\d+), max: (\\d+) \\}`).exec(GATEWAY);
  return { min: Number(found?.[1]), max: Number(found?.[2]) };
};
const numberOf = (name: string): number => Number(new RegExp(`export const ${name} = (\\d+)`).exec(GATEWAY)?.[1]);

describe("the vocabulary and the bounds are the gateway's", () => {
  it("says the same groups, kinds, bases and cadences", () => {
    expect([...ABSENCE_WATCH_GROUPS]).toEqual(listOf("ABSENCE_WATCH_GROUPS"));
    expect([...ABSENCE_WATCH_KINDS]).toEqual(listOf("ABSENCE_WATCH_KINDS"));
    expect([...ABSENCE_WATCH_BASES]).toEqual(listOf("ABSENCE_WATCH_BASES"));
    expect([...ABSENCE_WATCH_CADENCES]).toEqual(listOf("ABSENCE_WATCH_CADENCES"));
  });

  it("says the same figures and limits", () => {
    expect(PERCENT).toEqual(boundsOf("PERCENT"));
    expect(WINDOW_DAYS).toEqual(boundsOf("WINDOW_DAYS"));
    expect(CONSECUTIVE_DAYS).toEqual(boundsOf("CONSECUTIVE_DAYS"));
    expect(RECENT_DAYS).toBe(numberOf("RECENT_DAYS"));
    expect(FINDINGS_LIMIT).toBe(numberOf("FINDINGS_LIMIT"));
  });

  it("names the conflict the gateway answers a second limit with", () => {
    expect(SERVICE).toContain(`export const ABSENCE_WATCH_LIMIT_EXISTS = '${LIMIT_EXISTS}'`);
  });
});

describe("the figures", () => {
  const form = (over: Partial<LimitForm>): LimitForm => ({ ...emptyLimitForm(), ...over });

  it("reads a whole number and nothing else", () => {
    expect(wholeNumber("14")).toBe(14);
    expect(wholeNumber(" 14 ")).toBe(14);
    for (const text of ["", "1.5", "1,5", "-3", "1e2", "abc", "12345"]) expect(wholeNumber(text)).toBeNull();
  });

  it("names the figures of a share that are missing or outside their bounds", () => {
    expect(figureErrors(form({ kind: "SHARE" }))).toEqual(["percent", "windowDays"]);
    expect(figureErrors(form({ kind: "SHARE", percent: "0", windowDays: "6" }))).toEqual(["percent", "windowDays"]);
    expect(figureErrors(form({ kind: "SHARE", percent: "101", windowDays: "61" }))).toEqual(["percent", "windowDays"]);
    expect(figureErrors(form({ kind: "SHARE", percent: "1", windowDays: "7" }))).toEqual([]);
    expect(figureErrors(form({ kind: "SHARE", percent: "100", windowDays: "60" }))).toEqual([]);
  });

  it("asks a run for its days alone, whatever a share left in the other fields", () => {
    expect(figureErrors(form({ kind: "CONSECUTIVE", percent: "999", windowDays: "999" }))).toEqual(["consecutiveDays"]);
    expect(figureErrors(form({ kind: "CONSECUTIVE", consecutiveDays: "1" }))).toEqual(["consecutiveDays"]);
    expect(figureErrors(form({ kind: "CONSECUTIVE", consecutiveDays: "31" }))).toEqual(["consecutiveDays"]);
    expect(figureErrors(form({ kind: "CONSECUTIVE", consecutiveDays: "2" }))).toEqual([]);
    expect(figureErrors(form({ kind: "CONSECUTIVE", consecutiveDays: "30" }))).toEqual([]);
  });

  it("sends the figures of the kind and none of the other (the gateway refuses a limit that carries both)", () => {
    expect(figuresOfForm(form({ kind: "SHARE", percent: "10", windowDays: "14", consecutiveDays: "5" }))).toEqual({
      percent: 10,
      windowDays: 14,
    });
    expect(figuresOfForm(form({ kind: "CONSECUTIVE", percent: "10", windowDays: "14", consecutiveDays: "5" }))).toEqual({
      consecutiveDays: 5,
    });
  });

  it("fills the form from a limit, for the figures it has", () => {
    expect(
      formOfLimit({ id: "l", recipientGroup: "REKTOR", kind: "SHARE", basis: "VALID", percent: 10, windowDays: 14, consecutiveDays: null }),
    ).toEqual({ recipientGroup: "REKTOR", kind: "SHARE", basis: "VALID", percent: "10", windowDays: "14", consecutiveDays: "" });
  });
});

describe("the findings", () => {
  it("rounds the measured share to a whole percent, and has none for a run or for nothing registered", () => {
    expect(measuredPercent({ kind: "SHARE", absentMinutes: 100, recordedMinutes: 900 })).toBe(11);
    expect(measuredPercent({ kind: "SHARE", absentMinutes: 1, recordedMinutes: 3 })).toBe(33);
    expect(measuredPercent({ kind: "SHARE", absentMinutes: 5, recordedMinutes: 0 })).toBeNull();
    expect(measuredPercent({ kind: "SHARE", absentMinutes: null, recordedMinutes: null })).toBeNull();
    expect(measuredPercent({ kind: "CONSECUTIVE", absentMinutes: 100, recordedMinutes: 900 })).toBeNull();
  });

  it("puts the pupils over a limit before those back under it, each in the order they came", () => {
    const rows = [
      { id: "a", clearedOn: "2026-11-01" },
      { id: "b", clearedOn: null },
      { id: "c", clearedOn: "2026-11-02" },
      { id: "d", clearedOn: null },
    ];
    expect(openFirst(rows).map((row) => row.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("counts a pupil once however many limits they passed", () => {
    expect(pupilsIn([{ studentId: "p1" }, { studentId: "p1" }, { studentId: "p2" }])).toBe(2);
    expect(pupilsIn([])).toBe(0);
  });
});
