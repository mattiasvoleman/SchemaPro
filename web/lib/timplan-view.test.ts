import { describe, expect, it } from "vitest";
import { checkLocalTimplan, stageGradesFor } from "@/lib/timplan-coverage";
import {
  cellKey,
  entriesFromDraft,
  formatH,
  gridColumns,
  parseMinutes,
  parseWeeksTenths,
  rowTone,
  sameDraft,
  stageHours,
  pupilGradeMinutes,
  hasAlternatives,
  toCoverageVersion,
  verdictHighlight,
  type DraftCells,
} from "@/lib/timplan-view";
import { B1, LAW_2028, NATIONAL, SAMESKOLA, SPECIALSKOLA } from "@/lib/__fixtures__/timplan-statute";

const SUBJECTS = [
  { id: "s-ma", name: "Matematik", nationalCode: "MA", countsTowardTimplan: true },
  { id: "s-bl", name: "Bild", nationalCode: "BL", countsTowardTimplan: true },
  { id: "s-bi", name: "Biologi", nationalCode: "BI", countsTowardTimplan: true },
  { id: "s-ke", name: "Kemi", nationalCode: "KE", countsTowardTimplan: true },
  { id: "s-prog", name: "Programmering", nationalCode: null, countsTowardTimplan: true },
];

const draftOf = (cells: Record<string, number>): DraftCells =>
  new Map(Object.entries(cells).map(([key, minutes]) => [key, String(minutes)]));

/**
 * One plan reaching each tone at 35.6 weeks:
 *   MA åk 1–3 236+236+235 = 419,5 h of 420: protected, half an hour short → under
 *   BL åk 1–3 30 each = 53,4 h of 60: 11 % below, inside the 20 % cap → below
 *   BL åk 4–6 50 each = 89 h of 80 → met
 *   BI åk 4–6 120 each = 213,6 h, KE åk 4 20 = 11,9 h: NO 225,5 of 216 is met,
 *   but Kemi is under its 60 h minimum → Kemi under, Biologi not
 */
const DRAFT = draftOf({
  [cellKey("s-ma", 1)]: 236,
  [cellKey("s-ma", 2)]: 236,
  [cellKey("s-ma", 3)]: 235,
  [cellKey("s-bl", 1)]: 30,
  [cellKey("s-bl", 2)]: 30,
  [cellKey("s-bl", 3)]: 30,
  [cellKey("s-bl", 4)]: 50,
  [cellKey("s-bl", 5)]: 50,
  [cellKey("s-bl", 6)]: 50,
  [cellKey("s-bi", 4)]: 120,
  [cellKey("s-bi", 5)]: 120,
  [cellKey("s-bi", 6)]: 120,
  [cellKey("s-ke", 4)]: 20,
});

const check = checkLocalTimplan({
  planningWeeksTenths: 356,
  version: toCoverageVersion(B1),
  nationalSubjects: NATIONAL.subjects,
  subjects: SUBJECTS,
  entries: entriesFromDraft(DRAFT, new Map()).entries,
});

const parentOf = new Map(NATIONAL.subjects.map((subject) => [subject.code, subject.parentCode]));
const top = (code: string) => parentOf.get(code) ?? code;

describe("gridColumns follows the lydelse's årskurser", () => {
  const shape = (columns: ReturnType<typeof gridColumns>) =>
    columns.map((column) => (column.kind === "grade" ? String(column.grade) : `Σ${column.stage}`));

  it("grundskolan: F, 1–3, 4–6, 7–9, each stadium followed by its sum", () => {
    expect(shape(gridColumns(stageGradesFor(B1)))).toEqual([
      "0", "1", "2", "3", "ΣLAG", "4", "5", "6", "ΣMELLAN", "7", "8", "9", "ΣHOG",
    ]);
  });

  it("specialskolan runs to årskurs 10 and sameskolan stops at 6 with no högstadium", () => {
    expect(shape(gridColumns(stageGradesFor(SPECIALSKOLA)))).toEqual([
      "0", "1", "2", "3", "4", "ΣLAG", "5", "6", "7", "ΣMELLAN", "8", "9", "10", "ΣHOG",
    ]);
    expect(shape(gridColumns(stageGradesFor(SAMESKOLA)))).toEqual([
      "0", "1", "2", "3", "ΣLAG", "4", "5", "6", "ΣMELLAN",
    ]);
  });

  it("the 2028 grundskola re-cuts to 1–4 / 5–7 / 8–10", () => {
    expect(shape(gridColumns(stageGradesFor(LAW_2028)))).toEqual([
      "0", "1", "2", "3", "4", "ΣLAG", "5", "6", "7", "ΣMELLAN", "8", "9", "10", "ΣHOG",
    ]);
  });

  it("shows a stored årskurs outside the form at the end instead of hiding its minutes", () => {
    const columns = gridColumns(stageGradesFor(SAMESKOLA), [7, 2]);
    expect(columns.at(-1)).toEqual({ kind: "grade", grade: 7, stage: null });
    expect(columns.filter((column) => column.kind === "grade" && column.grade === 2)).toHaveLength(1);
  });
});

describe("stage sums are minutes × 35.6 weeks / 60, without float drift", () => {
  it("adds 236 + 236 + 235 min/vecka to 419,5 h, not 420", () => {
    expect(stageHours(DRAFT, "s-ma", [1, 2, 3], 356)).toBe(419.5);
    expect(formatH(stageHours(DRAFT, "s-ma", [1, 2, 3], 356))).toBe("419,5");
  });

  it("ignores empty and unreadable cells rather than reading them as 0 or NaN", () => {
    const draft = new Map([
      [cellKey("s-x", 1), "60"],
      [cellKey("s-x", 2), ""],
      [cellKey("s-x", 3), "6o"],
    ]);
    expect(stageHours(draft, "s-x", [1, 2, 3], 356)).toBe(35.6);
  });
});

describe("rowTone paints a row by the national cell it feeds", () => {
  it("red for a protected subject reduced, amber within the cap, green when met", () => {
    expect(rowTone(check, "MA", top("MA"), "LAG")).toBe("under");
    expect(rowTone(check, "BL", top("BL"), "LAG")).toBe("below");
    expect(rowTone(check, "BL", top("BL"), "MELLAN")).toBe("met");
  });

  it("red for the NO child under its own minimum, and not for its sibling that meets its own", () => {
    expect(check.verdicts.some((v) => v.code === "TIMPLAN_GROUP_MINIMUM_UNMET" && v.childCode === "KE")).toBe(true);
    expect(rowTone(check, "KE", top("KE"), "MELLAN")).toBe("under");
    expect(rowTone(check, "BI", top("BI"), "MELLAN")).toBe("met");
  });

  it("no tone at all for a subject without a code", () => {
    expect(rowTone(check, null, null, "HOG")).toBe("none");
  });
});

describe("verdictHighlight lights the cells a verdict is about", () => {
  const grades = check.stageGrades;

  it("a cell verdict lights its subjects in that stadium's årskurser", () => {
    const verdict = check.verdicts.find(
      (v) => v.code === "TIMPLAN_PROTECTED_SUBJECT_REDUCED" && v.subjectCode === "MA" && v.stage === "LAG",
    )!;
    const lit = verdictHighlight(verdict, SUBJECTS, grades);
    expect([...lit.subjectIds!]).toEqual(["s-ma"]);
    expect([...lit.grades!]).toEqual([1, 2, 3]);
    expect([...lit.stages]).toEqual(["LAG"]);
    expect(lit.footer).toBe(false);
  });

  it("a child's minimum lights the child's rows, not every NO subject", () => {
    const verdict = check.verdicts.find((v) => v.code === "TIMPLAN_GROUP_MINIMUM_UNMET" && v.childCode === "KE")!;
    expect([...verdictHighlight(verdict, SUBJECTS, grades).subjectIds!]).toEqual(["s-ke"]);
  });

  it("a cell with no minutes at all lights the subjects mapped to its code", () => {
    const verdict = check.verdicts.find(
      (v) => v.code === "TIMPLAN_PROTECTED_SUBJECT_REDUCED" && v.subjectCode === "MA" && v.stage === "MELLAN",
    )!;
    expect(verdict.subjectIds).toEqual([]);
    const lit = verdictHighlight(verdict, SUBJECTS, grades, parentOf);
    expect([...lit.subjectIds!]).toEqual(["s-ma"]);
    expect([...lit.grades!]).toEqual([4, 5, 6]);
  });

  it("a plan-wide verdict lights the footer", () => {
    const verdict = check.verdicts.find((v) => v.code === "TIMPLAN_TOTAL_BELOW_GUARANTEE")!;
    const lit = verdictHighlight(verdict, SUBJECTS, grades);
    expect(lit.footer).toBe(true);
    expect(lit.subjectIds).toBeNull();
  });
});

describe("the grid's text becomes the PUT body", () => {
  it("keeps 0 as an entry and an empty cell as none, and carries stored notes", () => {
    const draft = new Map([
      [cellKey("s-ma", 1), "0"],
      [cellKey("s-ma", 2), " "],
      [cellKey("s-bl", 1), "45"],
    ]);
    const { entries, invalid } = entriesFromDraft(draft, new Map([[cellKey("s-bl", 1), "Skolans val"]]));
    expect(invalid).toEqual([]);
    expect(entries).toEqual([
      { subjectId: "s-bl", gradeLevel: 1, minutesPerWeek: 45, note: "Skolans val" },
      { subjectId: "s-ma", gradeLevel: 1, minutesPerWeek: 0 },
    ]);
  });

  it("names the cells it cannot send instead of sending a guess", () => {
    const draft = new Map([
      [cellKey("s-ma", 1), "1201"],
      [cellKey("s-ma", 2), "-5"],
      [cellKey("s-ma", 3), "60,5"],
      [cellKey("s-ma", 4), "60"],
    ]);
    expect(entriesFromDraft(draft, new Map()).invalid).toEqual([
      cellKey("s-ma", 1),
      cellKey("s-ma", 2),
      cellKey("s-ma", 3),
    ]);
    expect(parseMinutes("1200")).toBe(1200);
  });

  it("treats a cleared cell and an absent one as the same draft", () => {
    expect(sameDraft(new Map([["a:1", "60"], ["a:2", ""]]), new Map([["a:1", " 60 "]]))).toBe(true);
    expect(sameDraft(new Map([["a:1", "60"]]), new Map([["a:1", "0"]]))).toBe(false);
  });
});

describe("parseWeeksTenths reads the weeks a Swedish keyboard types", () => {
  it("takes a decimal comma or point and refuses what the column would not store", () => {
    expect(parseWeeksTenths("35,6")).toBe(356);
    expect(parseWeeksTenths("35.6")).toBe(356);
    expect(parseWeeksTenths("40")).toBe(400);
    expect(parseWeeksTenths("19,9")).toBeNull();
    expect(parseWeeksTenths("35,65")).toBeNull();
    expect(parseWeeksTenths("")).toBeNull();
  });
});

describe("a pupil's minutes, with alternatives once", () => {
  const parent = new Map<string, string | null>([["BI", "NO"], ["NO", null], ["M2", null], ["SV_SVA", null]]);
  const subjects = [
    { id: "s-sv", nationalCode: "SV_SVA" },
    { id: "s-sva", nationalCode: "SV_SVA" },
    { id: "s-es", nationalCode: "M2" },
    { id: "s-de", nationalCode: "M2" },
    { id: "s-bi", nationalCode: "BI" },
    { id: "s-prog", nationalCode: null },
  ];
  const draft: DraftCells = new Map([
    [cellKey("s-sv", 7), "200"],
    [cellKey("s-sva", 7), "60"],
    [cellKey("s-es", 7), "60"],
    [cellKey("s-de", 7), "45"],
    [cellKey("s-bi", 7), "80"],
    [cellKey("s-prog", 7), "30"],
  ]);

  it("adds every subject, but Svenska/SvA and språkval once each, at the longest", () => {
    expect(pupilGradeMinutes(draft, subjects, 7, parent)).toBe(200 + 60 + 80 + 30);
  });

  it("knows when a plan has alternatives at all", () => {
    expect(hasAlternatives(subjects, parent)).toBe(true);
    expect(hasAlternatives([{ nationalCode: "SV_SVA" }, { nationalCode: "BI" }], parent)).toBe(false);
  });

  it("rounds a short row down and a met one to the nearest tenth", () => {
    expect(stageHours(DRAFT, "s-ma", [1, 2, 3], 356, true)).toBe(419.4);
    expect(stageHours(DRAFT, "s-ma", [1, 2, 3], 356)).toBe(419.5);
  });
});
