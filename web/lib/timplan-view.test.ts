import { describe, expect, it } from "vitest";
import { checkLocalTimplan, heldStageGrades, stageGradesFor, type GradeSpan } from "@/lib/timplan-coverage";
import {
  cellKey,
  cellTone,
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
import { B1, LAW_2028, NATIONAL, SAMESKOLA, SPECIALSKOLA, SPECIALSKOLA_2028 } from "@/lib/__fixtures__/timplan-statute";

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

  it("the 2028 specialskola runs to årskurs 11: 1–5 / 6–8 / 9–11", () => {
    expect(shape(gridColumns(stageGradesFor(SPECIALSKOLA_2028)))).toEqual([
      "0", "1", "2", "3", "4", "5", "ΣLAG", "6", "7", "8", "ΣMELLAN", "9", "10", "11", "ΣHOG",
    ]);
  });

  it("shows a stored årskurs outside the form at the end instead of hiding its minutes", () => {
    const columns = gridColumns(stageGradesFor(SAMESKOLA), [7, 2]);
    expect(columns.at(-1)).toEqual({ kind: "grade", grade: 7, stage: null });
    expect(columns.filter((column) => column.kind === "grade" && column.grade === 2)).toHaveLength(1);
  });
});

describe("gridColumns follows the plan's årskurs span", () => {
  const shape = (columns: ReturnType<typeof gridColumns>) =>
    columns.map((column) => (column.kind === "grade" ? `${column.grade}${column.stage === null ? "·" : ""}` : `Σ${column.stage}`));
  const grades = stageGradesFor(B1);
  const span = (gradeFrom: number, gradeTo: number): GradeSpan => ({ gradeFrom, gradeTo });

  it("shows a 4–9 plan's lågstadium grey, like förskoleklassen, and gives it no sum", () => {
    // · marks a column of no stage: the grey ones, whose minutes are stored and counted nowhere.
    expect(shape(gridColumns(grades, [], span(4, 9)))).toEqual([
      "0·", "1·", "2·", "3·", "4", "5", "6", "ΣMELLAN", "7", "8", "9", "ΣHOG",
    ]);
  });

  it("keeps a stadium the span holds whole exactly as with no span", () => {
    expect(gridColumns(grades, [], span(1, 9))).toEqual(gridColumns(grades));
    expect(gridColumns(grades, [], span(0, 9))).toEqual(gridColumns(grades));
    expect(gridColumns(grades, [], null)).toEqual(gridColumns(grades));
  });

  it("says a stadium the span holds part of is a share: åk 4–5 of mellanstadiet's three", () => {
    const columns = gridColumns(grades, [], span(0, 5));
    expect(shape(columns)).toEqual(["0·", "1", "2", "3", "ΣLAG", "4", "5", "6·", "ΣMELLAN", "7·", "8·", "9·"]);
    expect(columns.find((column) => column.kind === "stage" && column.stage === "MELLAN")).toEqual({
      kind: "stage",
      stage: "MELLAN",
      share: { held: 2, of: 3 },
    });
    // The whole stadium carries no share to state.
    expect(columns.find((column) => column.kind === "stage" && column.stage === "LAG")).toEqual({ kind: "stage", stage: "LAG" });
  });

  it("has no sum column for a stadium with no årskurs in the span", () => {
    const columns = gridColumns(grades, [], span(7, 9));
    expect(columns.filter((column) => column.kind === "stage").map((column) => column.stage)).toEqual(["HOG"]);
    expect(columns.filter((column) => column.kind === "grade" && column.stage === null)).toHaveLength(7);
  });

  it("cuts the 2028 lydelse in its own numbering", () => {
    expect(shape(gridColumns(stageGradesFor(LAW_2028), [], span(5, 10)))).toEqual([
      "0·", "1·", "2·", "3·", "4·", "5", "6", "7", "ΣMELLAN", "8", "9", "10", "ΣHOG",
    ]);
  });

  it("still puts a stored årskurs outside the form at the end, whatever the span", () => {
    const columns = gridColumns(stageGradesFor(SAMESKOLA), [7], span(4, 6));
    expect(columns.at(-1)).toEqual({ kind: "grade", grade: 7, stage: null });
  });
});

describe("tones with a span: a share is a notice, never a warning", () => {
  // F–5: lågstadiet whole, mellanstadiet two thirds. Matematik is protected,
  // and short in both stadier; biologi and kemi under the NO minima.
  const f5 = { gradeFrom: 0, gradeTo: 5 };
  const short = checkLocalTimplan({
    planningWeeksTenths: 356,
    version: toCoverageVersion(B1),
    nationalSubjects: NATIONAL.subjects,
    subjects: SUBJECTS,
    entries: entriesFromDraft(
      draftOf({
        [cellKey("s-ma", 1)]: 236,
        [cellKey("s-ma", 2)]: 236,
        [cellKey("s-ma", 3)]: 235,
        [cellKey("s-ma", 4)]: 100,
        [cellKey("s-ma", 5)]: 100,
        [cellKey("s-bl", 4)]: 10,
        [cellKey("s-bl", 5)]: 10,
        [cellKey("s-bi", 4)]: 10,
        [cellKey("s-ke", 4)]: 10,
      }),
      new Map(),
    ).entries,
    gradeSpan: f5,
  });

  it("the check raises the notice for the part-held stadium and the warning for the whole one", () => {
    expect(
      short.verdicts.some((v) => v.code === "TIMPLAN_PROTECTED_SUBJECT_REDUCED" && v.subjectCode === "MA" && v.stage === "LAG"),
    ).toBe(true);
    expect(
      short.verdicts.some((v) => v.code === "TIMPLAN_PARTIAL_STAGE_BELOW_SHARE" && v.subjectCode === "MA" && v.stage === "MELLAN"),
    ).toBe(true);
    expect(
      short.verdicts.some((v) => v.code === "TIMPLAN_PROTECTED_SUBJECT_REDUCED" && v.stage === "MELLAN"),
    ).toBe(false);
  });

  it("paints the stadium held whole red and the share amber, protected subject or not", () => {
    expect(rowTone(short, "MA", top("MA"), "LAG")).toBe("under");
    expect(rowTone(short, "MA", top("MA"), "MELLAN")).toBe("below");
    expect(rowTone(short, "BL", top("BL"), "MELLAN")).toBe("below");
  });

  it("paints a NO child under its share of the minimum amber, and does not let it tint its sibling", () => {
    const child = short.verdicts.find((v) => v.code === "TIMPLAN_PARTIAL_STAGE_BELOW_SHARE" && v.childCode === "KE");
    expect(child).toBeDefined();
    expect(short.verdicts.some((v) => v.code === "TIMPLAN_GROUP_MINIMUM_UNMET" && v.stage === "MELLAN")).toBe(false);
    expect(rowTone(short, "KE", top("KE"), "MELLAN")).toBe("below");
    // The group's own view of its cell, without the children's shares, is below too (the cell itself is short).
    const cell = short.cells.find((c) => c.subjectCode === "NO" && c.stage === "MELLAN");
    expect(cell?.share).toEqual({ held: 2, of: 3 });
    expect(cellTone(short, cell, false)).toBe("below");
  });

  it("a part-held cell states the share in hours, and the column says how many årskurser", () => {
    const cell = short.cells.find((c) => c.subjectCode === "MA" && c.stage === "MELLAN")!;
    expect(cell.share).toEqual({ held: 2, of: 3 });
    const columns = gridColumns(short.stageGrades, [], short.gradeSpan ?? null);
    expect(columns.some((column) => column.kind === "stage" && column.stage === "MELLAN" && column.share?.held === 2)).toBe(true);
  });

  it("lights only the årskurser the span holds when a share verdict is clicked", () => {
    const verdict = short.verdicts.find((v) => v.code === "TIMPLAN_PARTIAL_STAGE_BELOW_SHARE" && v.subjectCode === "MA")!;
    const lit = verdictHighlight(verdict, SUBJECTS, heldStageGrades(short.stageGrades, short.gradeSpan), parentOf);
    expect([...lit.subjectIds!]).toEqual(["s-ma"]);
    expect([...lit.grades!]).toEqual([4, 5]);
    expect([...lit.stages]).toEqual(["MELLAN"]);
    expect(lit.footer).toBe(false);
  });

  it("lights the footer for the total that is not judged for a span", () => {
    const unjudged = checkLocalTimplan({
      planningWeeksTenths: 356,
      version: toCoverageVersion(LAW_2028),
      nationalSubjects: NATIONAL.subjects,
      subjects: SUBJECTS,
      entries: [],
      gradeSpan: { gradeFrom: 5, gradeTo: 10 },
    });
    const verdict = unjudged.verdicts.find((v) => v.code === "TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN")!;
    expect(unjudged.total.judged).toBe(false);
    expect(verdictHighlight(verdict, SUBJECTS, unjudged.stageGrades).footer).toBe(true);
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
