import { describe, expect, it } from "vitest";
import {
  actorLabel,
  dutyLabelOf,
  formatHistoryValue,
  formatStamp,
  historyLines,
  latestVersion,
  periodLabelOf,
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
      validFrom: "Gäller från",
      validTo: "Gäller till och med",
      slotCount: "Fasta tider",
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
  times: (count) => (count === 1 ? "1 tid" : `${count} tider`),
  yearBound: "läsårets egen gräns",
  decimal: (value) => new Intl.NumberFormat("sv", { maximumFractionDigits: 3, useGrouping: false }).format(value),
  noteChanged: "Anteckningen skrevs eller ändrades (texten sparas inte i historiken).",
  hidden: "dolt",
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

  it("says a percentage hidden from the reader changed, as 'dolt', never as — → — (Roller i skolan)", () => {
    const hidden = { before: null, after: null, hrHidden: true as const };
    expect(
      historyLines(
        entry({
          changes: [
            { field: "employmentPercent", ...hidden },
            { field: "contractKind", before: "FERIE", after: "SEMESTER" },
          ],
        }),
        labels,
      ),
    ).toEqual(["Tjänstgöringsgrad: dolt", "Avtalsform: Ferietjänst → Semestertjänst"]);
    expect(historyLines(entry({ action: "CREATE", changes: [{ field: "reductionPercent", ...hidden }] }), labels)).toEqual([
      "Nedsättning: dolt",
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

  it("says an uppdrag's Från and Till as days, an empty one as the year's own bound, and its times as a count", () => {
    const moved = entry({
      entity: "DUTY",
      action: "UPDATE",
      changes: [
        { field: "validFrom", before: null, after: "2027-01-07" },
        { field: "validTo", before: "2026-12-18", after: null },
      ],
    });
    expect(historyLines(moved, labels)).toEqual([
      "Gäller från: läsårets egen gräns → 2027-01-07",
      "Gäller till och med: 2026-12-18 → läsårets egen gräns",
    ]);
    const times = entry({ entity: "DUTY", action: "UPDATE", changes: [{ field: "slotCount", before: 1, after: 3 }] });
    expect(historyLines(times, labels)).toEqual(["Fasta tider: 1 tid → 3 tider"]);
    // A post has no dates: an empty value there is still just empty.
    expect(formatHistoryValue("EMPLOYMENT", "validFrom", null, labels)).toBe("—");
  });

  it("says a period's versions with its dates and figures, an open Till as the year's own bound (20261022120000)", () => {
    const created = entry({
      entity: "PERIOD",
      action: "CREATE",
      changes: [
        { field: "validFrom", before: null, after: "2026-11-01" },
        { field: "validTo", before: null, after: null },
        { field: "employmentPercent", before: null, after: 80 },
      ],
    });
    expect(historyLines(created, labels)).toEqual([
      "Gäller från: 2026-11-01",
      "Gäller till och med: läsårets egen gräns",
      "Tjänstgöringsgrad: 80 %",
    ]);
    expect(periodLabelOf(created)).toBe("2026-11-01");
    // A deleted period by the Från it had; an update that kept its dates by none.
    expect(periodLabelOf({ ...created, action: "DELETE", changes: [{ field: "validFrom", before: "2026-11-01", after: null }] })).toBe(
      "2026-11-01",
    );
    // An update that moved only the grad: named by the Från the gateway sends beside it…
    const figuresOnly = entry({ entity: "PERIOD", action: "UPDATE", changes: [{ field: "employmentPercent", before: 80, after: 75 }] });
    expect(periodLabelOf({ ...figuresOnly, periodFrom: "2026-11-01" })).toBe("2026-11-01");
    // …and by none from a gateway that does not send it yet.
    expect(periodLabelOf(figuresOnly)).toBeNull();
    expect(periodLabelOf(entry({ entity: "DUTY", changes: [{ field: "validFrom", before: null, after: "2026-11-01" }] }))).toBeNull();
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
