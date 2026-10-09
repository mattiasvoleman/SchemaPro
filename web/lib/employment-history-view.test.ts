import { describe, expect, it } from "vitest";
import {
  actorLabel,
  dutyLabelOf,
  formatHistoryValue,
  formatStamp,
  historyLines,
  latestVersion,
  versionStampOf,
  type HistoryLabels,
} from "./employment-history-view";
import type { HistoryEntry } from "./staffing-history-queries";

const labels: HistoryLabels = {
  field: (_entity, field) =>
    ({
      employmentPercent: "Tjänstgöringsgrad",
      reductionPercent: "Nedsättning",
      contractKind: "Avtalsform",
      label: "Benämning",
      minutesPerWeek: "Tid",
      countsAsTeaching: "Räknas",
      studentGroupId: "Grupp",
      kind: "Typ",
      blockedConstraintId: "Blockerad tid",
      subjectId: "Ämne",
    })[field] ?? null,
  contract: (kind) => (kind === "FERIE" ? "Ferietjänst" : "Semestertjänst"),
  dutyKind: (kind) => (kind === "MENTORSKAP" ? "Mentorskap" : kind),
  subject: (id) => (id === "s-ma" ? "Matematik" : null),
  group: (id) => (id === "g-7b" ? "7B" : null),
  minutes: (minutes) => `${minutes} min/v`,
  percent: (percent) => `${percent} %`,
  yes: "ja",
  no: "nej",
  empty: "—",
  removed: "borttaget",
  blocked: "blockerad tid",
  decimal: (value) => new Intl.NumberFormat("sv", { maximumFractionDigits: 3, useGrouping: false }).format(value),
  noteChanged: "Anteckningen skrevs eller ändrades (texten sparas inte i historiken).",
};

const entry = (overrides: Partial<HistoryEntry>): HistoryEntry => ({
  id: "l1",
  version: 1,
  entity: "EMPLOYMENT",
  entityId: "e1",
  action: "UPDATE",
  actorId: "u-admin",
  createdAt: "2026-10-09T12:02:00.000Z",
  changes: [],
  ...overrides,
});

describe("historyLines", () => {
  it("says a note was written in one sentence, never as a value", () => {
    expect(
      historyLines(
        entry({
          changes: [
            { field: "reductionPercent", before: 0, after: 10 },
            { field: "noteChanged", before: null, after: true },
          ],
        }),
        labels,
      ),
    ).toEqual(["Nedsättning: 0 % → 10 %", "Anteckningen skrevs eller ändrades (texten sparas inte i historiken)."]);
  });

  it("says an update before → after, with the post's percentages and avtalsform in words", () => {
    expect(
      historyLines(
        entry({
          changes: [
            { field: "employmentPercent", before: 100, after: 66.667 },
            { field: "reductionPercent", before: null, after: 20 },
            { field: "contractKind", before: "FERIE", after: "SEMESTER" },
          ],
        }),
        labels,
      ),
    ).toEqual([
      "Tjänstgöringsgrad: 100 % → 66,667 %",
      "Nedsättning: — → 20 %",
      "Avtalsform: Ferietjänst → Semestertjänst",
    ]);
  });

  it("states what an uppdrag was created with and what a deleted one had", () => {
    const created = entry({
      entity: "DUTY",
      action: "CREATE",
      changes: [
        { field: "kind", before: null, after: "MENTORSKAP" },
        { field: "label", before: null, after: "Mentor 7B" },
        { field: "minutesPerWeek", before: null, after: 90 },
        { field: "countsAsTeaching", before: null, after: false },
        { field: "studentGroupId", before: null, after: "g-7b" },
        { field: "blockedConstraintId", before: null, after: "c1" },
      ],
    });
    expect(historyLines(created, labels)).toEqual([
      "Typ: Mentorskap",
      "Benämning: Mentor 7B",
      "Tid: 90 min/v",
      "Räknas: nej",
      "Grupp: 7B",
      "Blockerad tid: blockerad tid",
    ]);
    expect(dutyLabelOf(created)).toBe("Mentor 7B");
    const deleted = entry({
      entity: "DUTY",
      action: "DELETE",
      changes: [
        { field: "label", before: "Mentor 7B", after: null },
        { field: "subjectId", before: "s-gone", after: null },
      ],
    });
    expect(historyLines(deleted, labels)).toEqual(["Benämning: Mentor 7B", "Ämne: borttaget"]);
    expect(dutyLabelOf(deleted)).toBe("Mentor 7B");
  });

  it("never hides a field it does not know: its own name and raw value", () => {
    expect(
      historyLines(entry({ changes: [{ field: "futureColumn", before: 1, after: { a: 2 } }] }), labels),
    ).toEqual(['futureColumn: 1 → {"a":2}']);
    expect(formatHistoryValue("EMPLOYMENT", "signature", "", labels)).toBe("—");
  });
});

describe("actorLabel", () => {
  const nameOf = (id: string) => (id === "u-admin" ? "Anna Admin" : null);
  it("names the actor, says System for null and a deleted user for an unknown id", () => {
    const words = { system: "System", deleted: "Borttagen användare" };
    expect(actorLabel("u-admin", nameOf, words)).toBe("Anna Admin");
    expect(actorLabel(null, nameOf, words)).toBe("System");
    expect(actorLabel("u-gone", nameOf, words)).toBe("Borttagen användare");
  });
});

describe("formatStamp and latestVersion", () => {
  it("writes the school's local minute, summer time included", () => {
    expect(formatStamp("2026-10-09T12:02:00.000Z", "Europe/Stockholm")).toBe("2026-10-09 14:02");
    expect(formatStamp("2026-12-09T23:30:00.000Z", "Europe/Stockholm")).toBe("2026-12-10 00:30");
  });

  it("cites the newest version of post and uppdrag alike, and nothing before the first write", () => {
    expect(latestVersion([])).toBeNull();
    expect(latestVersion(undefined)).toBeNull();
    expect(
      latestVersion([
        entry({ version: 7, createdAt: "2026-10-09T12:00:00.000Z" }),
        entry({ version: 9, entity: "DUTY", createdAt: "2026-10-10T08:00:00.000Z" }),
        entry({ version: 8 }),
      ]),
    ).toEqual({ version: 9, createdAt: "2026-10-10T08:00:00.000Z" });
  });
});

describe("formatHistoryValue in the reader's decimal mark", () => {
  it("writes 66,667 % for a Swedish reader and 66.667 % for an English one", () => {
    const en: HistoryLabels = {
      ...labels,
      decimal: (value) => new Intl.NumberFormat("en", { maximumFractionDigits: 3, useGrouping: false }).format(value),
    };
    expect(formatHistoryValue("EMPLOYMENT", "employmentPercent", 66.6667, labels)).toBe("66,667 %");
    expect(formatHistoryValue("EMPLOYMENT", "employmentPercent", "66.667", en)).toBe("66.667 %");
  });
});

describe("versionStampOf", () => {
  it("says no version only after a successful read; a read in flight or failed is never null", () => {
    const v7 = entry({ version: 7, createdAt: "2026-10-09T12:02:00.000Z" });
    expect(versionStampOf({ isSuccess: true, isError: false, data: { entries: [v7] } })).toEqual({
      version: 7,
      createdAt: "2026-10-09T12:02:00.000Z",
    });
    expect(versionStampOf({ isSuccess: true, isError: false, data: { entries: [] } })).toBeNull();
    expect(versionStampOf({ isSuccess: false, isError: false, data: undefined })).toBe("loading");
    expect(versionStampOf({ isSuccess: false, isError: true, data: undefined })).toBe("unreadable");
  });
});
