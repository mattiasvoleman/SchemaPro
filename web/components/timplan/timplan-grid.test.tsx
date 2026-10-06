import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { checkLocalTimplan, stageGradesFor } from "@/lib/timplan-coverage";
import {
  cellKey,
  entriesFromDraft,
  gridColumns,
  toCoverageVersion,
  verdictHighlight,
  type DraftCells,
} from "@/lib/timplan-view";
import type { Subject } from "@/lib/types";
import { B1, NATIONAL } from "@/lib/__fixtures__/timplan-statute";
import { TimplanGrid } from "./timplan-grid";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const subject = (id: string, name: string, nationalCode: string | null, counts = true): Subject => ({
  id,
  name,
  code: nationalCode,
  color: null,
  requiredRoomTypeId: null,
  nationalCode,
  countsTowardTimplan: counts,
});

const SUBJECTS = [
  subject("s-bl", "Bild", "BL"),
  subject("s-bi", "Biologi", "BI"),
  subject("s-ke", "Kemi", "KE"),
  subject("s-ma", "Matematik", "MA"),
  subject("s-mt", "Mentorstid", null, false),
  subject("s-prog", "Programmering", null),
];

/** See lib/timplan-view.test.ts for what each row reaches at 35.6 weeks. */
const CELLS: Record<string, number> = {
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
  [cellKey("s-mt", 7)]: 40,
  [cellKey("s-prog", 8)]: 40,
};

const parentOf = new Map(NATIONAL.subjects.map((entry) => [entry.code, entry.parentCode]));

function checkOf(draft: DraftCells, weeksTenths = 356) {
  return checkLocalTimplan({
    planningWeeksTenths: weeksTenths,
    version: toCoverageVersion(B1),
    nationalSubjects: NATIONAL.subjects,
    subjects: SUBJECTS,
    entries: entriesFromDraft(draft, new Map()).entries,
  });
}

/** The grid with its draft held in state, as the page holds it. */
function Harness({
  readOnly = false,
  highlightCode,
  highlightChild,
  notes = new Map(),
}: {
  readOnly?: boolean;
  highlightCode?: string;
  highlightChild?: string;
  notes?: Map<string, string | null>;
}) {
  const [draft, setDraft] = useState<DraftCells>(
    new Map(Object.entries(CELLS).map(([key, minutes]) => [key, String(minutes)])),
  );
  const check = checkOf(draft);
  const verdict = highlightCode
    ? check.verdicts.find(
        (v) => v.code === highlightCode && (highlightChild === undefined || v.childCode === highlightChild),
      )
    : undefined;
  return (
    <TimplanGrid
      subjects={SUBJECTS}
      parentOf={parentOf}
      columns={gridColumns(check.stageGrades)}
      stageGrades={check.stageGrades}
      draft={draft}
      notes={notes}
      check={check}
      weeksTenths={356}
      readOnly={readOnly}
      highlight={verdict ? verdictHighlight(verdict, SUBJECTS, check.stageGrades) : null}
      onCellChange={(key, text) => setDraft((old) => new Map(old).set(key, text))}
    />
  );
}

const row = (subjectId: string) =>
  document.querySelector<HTMLTableRowElement>(`tr[data-subject-id="${subjectId}"]`)!;
const stageCell = (subjectId: string, stage: string) =>
  row(subjectId).querySelector<HTMLTableCellElement>(`td[data-stage="${stage}"]`)!;
const input = (subjectId: string, grade: number) =>
  within(row(subjectId)).getAllByRole("textbox")[grade]! as HTMLInputElement;

describe("TimplanGrid", () => {
  it("has a column per årskurs F–9 with a sum after each stadium", () => {
    render(<Harness />);
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).toEqual([
      "subjectColumn",
      "gradeColumn(0)", "gradeColumn(1)", "gradeColumn(2)", "gradeColumn(3)", "stageSumColumn(stagesShort.LAG)",
      "gradeColumn(4)", "gradeColumn(5)", "gradeColumn(6)", "stageSumColumn(stagesShort.MELLAN)",
      "gradeColumn(7)", "gradeColumn(8)", "gradeColumn(9)", "stageSumColumn(stagesShort.HOG)",
    ]);
  });

  it("sums a stadium as minutes × 35,6 weeks / 60 beside the national hours", () => {
    render(<Harness />);
    const ma = stageCell("s-ma", "LAG");
    // 236 + 236 + 235 = 707 min/vecka → 419,49 h, half an hour under 420 —
    // shown rounded DOWN, as the check shows a short figure, so 419,4 and the
    // 0,6 h deficit make the 420 a reader sees.
    expect(ma).toHaveTextContent("419,4");
    expect(ma).not.toHaveTextContent("419,5");
    expect(ma).toHaveTextContent("stageCellNational(419,4|420)");
    expect(stageCell("s-bl", "MELLAN")).toHaveTextContent("89");
  });

  it("colours each sum by its national cell's verdict, and says the tone in words too", () => {
    render(<Harness />);
    // Protected subject reduced → red.
    expect(stageCell("s-ma", "LAG")).toHaveAttribute("data-tone", "under");
    expect(stageCell("s-ma", "LAG")).toHaveTextContent("tones.under");
    // 11 % under bild's 60 h, inside the 20 % cap → amber.
    expect(stageCell("s-bl", "LAG")).toHaveAttribute("data-tone", "below");
    // 89 of 80 h → green.
    expect(stageCell("s-bl", "MELLAN")).toHaveAttribute("data-tone", "met");
    // Kemi under its 60 h minimum within NO → red, while Biologi, whose own
    // minimum is met, stays green although it shares the NO cell.
    expect(stageCell("s-ke", "MELLAN")).toHaveAttribute("data-tone", "under");
    expect(stageCell("s-ke", "MELLAN")).toHaveTextContent("stageCellChild(60)");
    expect(stageCell("s-bi", "MELLAN")).toHaveAttribute("data-tone", "met");
    // A subject without a code is skolans val: no colour, a badge instead.
    expect(stageCell("s-prog", "HOG")).toHaveAttribute("data-tone", "none");
    expect(within(row("s-prog")).getByText("skolansValBadge")).toBeInTheDocument();
  });

  it("repaints a sum and its colour as the admin types", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const cell = input("s-ma", 3);
    await user.clear(cell);
    await user.type(cell, "236");
    // 236 × 3 = 708 min/vecka → 420,1 h: the protected cell is met.
    expect(stageCell("s-ma", "LAG")).toHaveTextContent("420,1");
    expect(stageCell("s-ma", "LAG")).toHaveAttribute("data-tone", "met");
  });

  it("keeps the subjects that are not undervisningstid apart, editable but never summed", () => {
    render(<Harness />);
    expect(screen.getByText("notCountedHeading")).toBeInTheDocument();
    const mentorstid = row("s-mt");
    expect(mentorstid.querySelectorAll("td[data-tone]")).toHaveLength(0);
    expect(input("s-mt", 7)).toHaveValue("40");
    // The column sum for åk 7 leaves Mentorstid's 40 out; åk 8 holds
    // Programmering's 40, which counts. Cells after the row header: F 1 2 3
    // Σlåg 4 5 6 Σmellan 7 8 → åk 7 is the tenth, åk 8 the eleventh.
    const sums = document.querySelector("tfoot tr")!.querySelectorAll("td");
    expect(sums[9]).toHaveTextContent(/^0$/);
    expect(sums[10]).toHaveTextContent(/^40$/);
  });

  it("marks a cell that is not 0–1200 whole minutes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const cell = input("s-bl", 7);
    await user.type(cell, "1300");
    expect(cell).toHaveAttribute("aria-invalid", "true");
  });

  it("is read-only when the plan is decided: no keystroke changes a cell", async () => {
    const user = userEvent.setup();
    render(<Harness readOnly />);
    const cell = input("s-ma", 1);
    expect(cell).toHaveAttribute("readonly");
    expect(cell).toHaveAttribute("aria-readonly", "true");
    await user.type(cell, "9");
    expect(cell).toHaveValue("236");
  });

  it("lights the cells and the sum a selected verdict is about, and nothing else", () => {
    render(<Harness highlightCode="TIMPLAN_GROUP_MINIMUM_UNMET" highlightChild="KE" />);
    expect(input("s-ke", 4)).toHaveAttribute("data-highlighted", "true");
    expect(input("s-ke", 7)).not.toHaveAttribute("data-highlighted");
    expect(stageCell("s-ke", "MELLAN")).toHaveAttribute("data-highlighted", "true");
    expect(input("s-bi", 4)).not.toHaveAttribute("data-highlighted");
  });

  it("lights the group's rows for a child the plan has no subject for (fysik)", () => {
    render(<Harness highlightCode="TIMPLAN_GROUP_MINIMUM_UNMET" highlightChild="FY" />);
    expect(input("s-bi", 4)).toHaveAttribute("data-highlighted", "true");
    expect(input("s-ke", 4)).toHaveAttribute("data-highlighted", "true");
    expect(input("s-ma", 4)).not.toHaveAttribute("data-highlighted");
  });

  it("lights the footer for a verdict about the whole plan", () => {
    render(<Harness highlightCode="TIMPLAN_TOTAL_BELOW_GUARANTEE" />);
    expect(document.querySelector("tfoot")).toHaveAttribute("data-highlighted", "true");
    expect(document.querySelectorAll("input[data-highlighted]")).toHaveLength(0);
  });

  it("states the total against the guarantee and the skolans val pool", () => {
    render(<Harness />);
    const footer = document.querySelector("tfoot")!;
    expect(within(footer).getByText(/footerTotalValue\(.*\|6890\)/)).toBeInTheDocument();
    expect(within(footer).getByText(/footerSkolansValValue\(.*\|600\|/)).toBeInTheDocument();
  });

  it("shows a stored note on its cell", () => {
    render(<Harness notes={new Map([[cellKey("s-prog", 8), "Skolans val"]])} />);
    expect(input("s-prog", 8)).toHaveAttribute("title", "cellNote(Skolans val)");
  });

  it("sums a column of alternatives once, at the longest: three språkval languages are not three times the time", () => {
    const languages = [subject("s-es", "Spanska", "M2"), subject("s-de", "Tyska", "M2"), subject("s-fr", "Franska", "M2")];
    const subjects = [...SUBJECTS, ...languages];
    const draft: DraftCells = new Map([
      [cellKey("s-ma", 7), "120"],
      [cellKey("s-es", 7), "60"],
      [cellKey("s-de", 7), "60"],
      [cellKey("s-fr", 7), "45"],
    ]);
    const check = checkLocalTimplan({
      planningWeeksTenths: 356,
      version: toCoverageVersion(B1),
      nationalSubjects: NATIONAL.subjects,
      subjects,
      entries: entriesFromDraft(draft, new Map()).entries,
    });
    render(
      <TimplanGrid
        subjects={subjects}
        parentOf={parentOf}
        columns={gridColumns(check.stageGrades)}
        stageGrades={check.stageGrades}
        draft={draft}
        notes={new Map()}
        check={check}
        weeksTenths={356}
        readOnly={false}
        highlight={null}
        onCellChange={() => {}}
      />,
    );
    const footer = document.querySelector("tfoot tr")!;
    const cells = footer.querySelectorAll("td");
    // F, 1, 2, 3, LAG, 4, 5, 6, MELLAN, then åk 7: 120 + the longest language (60), not 285.
    expect(cells[9]).toHaveTextContent("180");
    // 180 min × 35,6 weeks / 60 = 106,8 h, which is also the check's figure.
    expect(cells[12]).toHaveTextContent("106,8");
    expect(check.cells.find((c) => c.subjectCode === "M2" && c.stage === "HOG")!.plannedHours).toBe(35.6);
    expect(footer).toHaveTextContent("footerColumnSumAlternatives");
  });

  it("calls an uncoded subject skolans val only where the bilaga prints a pool", () => {
    render(<Harness />);
    expect(row("s-prog")).toHaveTextContent("skolansValBadge");
  });
});
