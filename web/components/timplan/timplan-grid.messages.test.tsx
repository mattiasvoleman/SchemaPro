import { render, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { checkLocalTimplan, type CoverageVersion, type GradeSpan } from "@/lib/timplan-coverage";
import { cellKey, entriesFromDraft, gridColumns, toCoverageVersion, type DraftCells } from "@/lib/timplan-view";
import type { Subject } from "@/lib/types";
import { B1, LAW_2028, NATIONAL } from "@/lib/__fixtures__/timplan-statute";
import sv from "@/messages/sv.json";
import { TimplanGrid } from "./timplan-grid";

/*
 * The empty-plan texts of the grid with the real Swedish messages: the other
 * grid test echoes keys, so it proves which text is CHOSEN but not whether
 * what it then says is true of the plan on screen.
 */

const subject = (id: string, name: string, nationalCode: string | null): Subject => ({
  id,
  name,
  code: nationalCode,
  color: null,
  requiredRoomTypeId: null,
  nationalCode,
  countsTowardTimplan: true,
});

const parentOf = new Map(NATIONAL.subjects.map((entry) => [entry.code, entry.parentCode]));

function renderGrid(subjects: Subject[], cells: Record<string, number>, version: CoverageVersion, gradeSpan?: GradeSpan) {
  const draft: DraftCells = new Map(Object.entries(cells).map(([key, minutes]) => [key, String(minutes)]));
  const check = checkLocalTimplan({
    planningWeeksTenths: 356,
    version,
    nationalSubjects: NATIONAL.subjects,
    subjects,
    entries: entriesFromDraft(draft, new Map()).entries,
    ...(gradeSpan ? { gradeSpan } : {}),
  });
  render(
    <NextIntlClientProvider locale="sv" messages={sv}>
      <TimplanGrid
        subjects={subjects}
        parentOf={parentOf}
        columns={gridColumns(check.stageGrades, [], check.gradeSpan ?? null)}
        stageGrades={check.stageGrades}
        draft={draft}
        notes={new Map()}
        check={check}
        weeksTenths={356}
        readOnly={false}
        highlight={null}
        onCellChange={() => {}}
      />
    </NextIntlClientProvider>,
  );
  return check;
}

/** The Skolans val footer cell. */
const poolCell = () => document.querySelector("tfoot")!.querySelectorAll("tr")[2]!.querySelector("td")!;

describe("TimplanGrid's empty-plan texts, in Swedish", () => {
  it("does not say a subject has no minutes, or that nothing is planned, when its minutes are in förskoleklass", () => {
    // Review: the check skips grades outside the stages before it records an
    // uncoded subject, so förskoleklass-only minutes left Bild "ännu inga
    // minuter i planen" and the footer "Inget planerat ännu" — both false.
    renderGrid([subject("s-bl", "Bild", null)], { [cellKey("s-bl", 0)]: 60 }, toCoverageVersion(B1));
    const row = document.querySelector<HTMLTableRowElement>('tr[data-subject-id="s-bl"]')!;
    const badge = within(row).getByText("ingen nationell kod");
    expect(badge.getAttribute("title")).not.toMatch(/inga minuter i planen/);
    expect(badge.getAttribute("title")).toMatch(/räknas mot timplanen/);
    expect(poolCell().textContent).not.toMatch(/^Inget planerat ännu/);
    expect(poolCell().textContent).toMatch(/räknas mot timplanen/);
  });

  it("does not promise a skolans val figure in an empty plan whose timplan prints no pool", () => {
    // Without a pool the minutes of an uncoded subject are the school's own
    // time ("egen tid"), so "skolans val räknas när ämnena har fått minuter"
    // promised a figure that never comes.
    const check = renderGrid([subject("s-ma", "Matematik", "MA")], {}, { ...toCoverageVersion(B1), entries: [] });
    expect(check.skolansVal.availableHours).toBeNull();
    expect(poolCell().textContent).not.toMatch(/skolans val/i);
  });
});

describe("TimplanGrid's texts for a plan with an årskurs span, in Swedish", () => {
  const MA = subject("s-ma", "Matematik", "MA");
  const footer = () => document.querySelector("tfoot")!;
  const totalCell = () => footer().querySelectorAll("tr")[1]!.querySelector("td")!;

  it("calls the guarantee and the pool of a 4–9 plan estimates, with the figures the plan's årskurser hold", () => {
    renderGrid([MA], { [cellKey("s-ma", 4)]: 100 }, toCoverageVersion(B1), { gradeFrom: 4, gradeTo: 9 });
    expect(totalCell().textContent).toMatch(/av 4 ?988 h garanterad undervisningstid \(en uppskattning efter planens årskurser\)/);
    expect(poolCell().textContent).toMatch(/av 434,4 h tagna ur ämnena \(potten är en uppskattning efter planens årskurser\)/);
  });

  it("states a whole form's figures without the word, also when a span names every årskurs", () => {
    renderGrid([MA], { [cellKey("s-ma", 4)]: 100 }, toCoverageVersion(B1), { gradeFrom: 0, gradeTo: 9 });
    expect(totalCell().textContent).toMatch(/av 6 ?890 h garanterad undervisningstid under mål$/);
    expect(poolCell().textContent).not.toContain("uppskattning");
  });

  it("names the share of a part-held stadium in the header and the cell", () => {
    renderGrid([MA], { [cellKey("s-ma", 4)]: 100, [cellKey("s-ma", 5)]: 100 }, toCoverageVersion(B1), { gradeFrom: 0, gradeTo: 5 });
    expect(document.querySelector("thead")!.textContent).toContain("2 av 3 årskurser");
    const mellan = document.querySelector('tr[data-subject-id="s-ma"] td[data-stage="MELLAN"]')!;
    expect(mellan.textContent).toMatch(/av andelen \d+,\d h/);
  });

  it("says a lydelse with no cells holds a part of the form to no total, instead of 'under'", () => {
    renderGrid([MA], { [cellKey("s-ma", 6)]: 100 }, toCoverageVersion(LAW_2028), { gradeFrom: 5, gradeTo: 10 });
    expect(totalCell().textContent).toMatch(/^[\d ,]+ h planerat\. Den garanterade tiden, 7 ?424 h, gäller hela skolformen och jämförs inte med en del av den\./);
    expect(totalCell().textContent).not.toContain("under mål");
    expect(totalCell().textContent).toContain("ingen nationell jämförelse");
  });
});
