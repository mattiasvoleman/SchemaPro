import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { cellSentence, TargetCellBody, TargetHint } from "@/components/timplan/requirements-target";
import {
  buildTargetView,
  targetInput,
  type DraftFields,
  type TargetSources,
} from "@/lib/requirements-target";
import { computePlannedCoverage } from "@/lib/timplan-planned";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

/**
 * The words Mål mode says of a part of a national subject: the tag in the
 * cell, the sentence a screen reader gets (an aria-label replaces the cell's
 * contents, so the line's figures have to be in it), and the dialog's hint.
 * Slöjd, Textilslöjd and Trä- och metallslöjd are all SL; the plan's 65 is on
 * Slöjd alone, so the two parts have no entry of their own.
 */

const subjects = [
  { id: "s-sl", name: "Slöjd", nationalCode: "SL", countsTowardTimplan: true },
  { id: "s-tx", name: "Textilslöjd", nationalCode: "SL", countsTowardTimplan: true },
  { id: "s-tm", name: "Trä- och metallslöjd", nationalCode: "SL", countsTowardTimplan: true },
  { id: "s-sv", name: "Svenska", nationalCode: "SV_SVA", countsTowardTimplan: true },
  { id: "s-sva", name: "Svenska som andraspråk", nationalCode: "SV_SVA", countsTowardTimplan: true },
];
const plans = [
  {
    id: "p",
    name: "Grundskola 2026",
    status: "DECIDED" as const,
    entries: [
      { subjectId: "s-sl", gradeLevel: 7, minutesPerWeek: 65 },
      { subjectId: "s-sv", gradeLevel: 7, minutesPerWeek: 200 },
      { subjectId: "s-sva", gradeLevel: 7, minutesPerWeek: 200 },
    ],
  },
];
const row = (id: string, subjectId: string, lessonsPerWeek: number, minutesPerLesson: number) => ({
  id,
  studentGroupId: "g-7a",
  subjectId,
  lessonsPerWeek,
  minutesPerLesson,
  recurrence: "ALL_WEEKS" as const,
  startDate: null,
  endDate: null,
});
const sourcesWith = (requirements: TargetSources["requirements"]): TargetSources => ({
  year: { startDate: "2026-08-17", endDate: "2027-06-11" },
  closures: [],
  attachments: [{ gradeLevel: 7, localTimplanId: "p" }],
  plans,
  subjects,
  groups: [{ id: "g-7a", name: "7A", kind: "CLASS", gradeLevel: 7 }],
  requirements,
  people: [],
  memberships: [],
});
const viewOf = (requirements: TargetSources["requirements"]) => {
  const input = targetInput(sourcesWith(requirements));
  return { input, view: buildTargetView(computePlannedCoverage(input), plans) };
};
const fields = (overrides: Partial<DraftFields> = {}): DraftFields => ({
  lessonsPerWeek: "1",
  minutesPerLesson: "65",
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
  ...overrides,
});
/** The sentence as `t` would build it, with the values in their order. */
const identity = (key: string, values?: Record<string, string | number>) =>
  values ? `${key}(${Object.values(values).join("|")})` : key;

describe("a part of a national line in Mål mode", () => {
  // Textilslöjd 1 × 65 meets the 65 on Slöjd, which the part has no entry for.
  const met = viewOf([row("r-tx", "s-tx", 1, 65)]);
  // Textilslöjd 1 × 40 and Trä- och metallslöjd 1 × 20: 60 of 65 on the line.
  const under = viewOf([row("r-tx", "s-tx", 1, 40), row("r-tm", "s-tm", 1, 20)]);
  // Svenska 4 × 50 meets the 200 that SvA shares: an alternative, not a part.
  const alternative = viewOf([row("r-sv", "s-sv", 4, 50)]);

  it("tags a part on a line that is not short with 'delar', as an alternative is tagged 'alternativ'", () => {
    const cell = met.view.cell("g-7a", "s-tx")!;
    expect(cell).toMatchObject({ national: true, tone: "met", target: null });
    const { container } = render(<TargetCellBody cell={cell} />);
    expect(container).toHaveTextContent("65 / —");
    expect(container).toHaveTextContent("target.tagParts");
    expect(container).not.toHaveTextContent("target.tagAlternative");
  });

  it("tags an alternative with 'alternativ' and not with 'delar'", () => {
    const { container } = render(<TargetCellBody cell={alternative.view.cell("g-7a", "s-sva")!} />);
    expect(container).toHaveTextContent("target.tagAlternative");
    expect(container).not.toHaveTextContent("target.tagParts");
  });

  it("shows the line's difference and not the tag on a part of a line that is short", () => {
    const cell = under.view.cell("g-7a", "s-tx")!;
    expect(cell).toMatchObject({ national: true, tone: "under", delta: -5 });
    const { container } = render(<TargetCellBody cell={cell} />);
    expect(container).toHaveTextContent("−5");
    expect(container).not.toHaveTextContent("target.tagParts");
  });

  it("reads the parts' sentence for a part, naming the line's other subjects, and the shared one for an alternative", () => {
    const part = cellSentence(identity, met.view.cell("g-7a", "s-tx")!, met.input);
    expect(part).toContain("target.cellParts(Slöjd)");
    expect(part).not.toContain("target.cellTogether");
    const shared = cellSentence(identity, alternative.view.cell("g-7a", "s-sva")!, alternative.input);
    expect(shared).toContain("target.cellTogether(Svenska)");
    expect(shared).not.toContain("target.cellParts");
  });

  it("reads a part by its line: 40 of 65, not 40 of 0 minutes, for a part the plan has no entry for", () => {
    const cell = viewOf([row("r-tx", "s-tx", 1, 40)]);
    expect(cellSentence(identity, cell.view.cell("g-7a", "s-tx")!, cell.input)).toBe(
      // planned | target | deficit | surplus, then the other part of the line
      "target.cellUnder(40|65|25|-25) target.cellParts(Slöjd)",
    );
  });

  it("reads every part by the line's minutes: 60 of 65 with five short, whichever part the cell is", () => {
    for (const subject of ["s-tx", "s-tm", "s-sl"]) {
      const sentence = cellSentence(identity, under.view.cell("g-7a", subject)!, under.input);
      expect(sentence, subject).toMatch(/^target\.cellUnder\(60\|65\|5\|-5\) target\.cellParts\(/);
    }
  });

  it("says in the dialog that the parts count together toward the target, and the shared target for an alternative", () => {
    render(<TargetHint input={met.input} groupId="g-7a" subjectId="s-tx" fields={fields()} />);
    expect(screen.getByRole("status")).toHaveTextContent("target.hintParts(Slöjd)");
    expect(screen.getByRole("status")).not.toHaveTextContent("target.hintTogether");
  });

  it("says the target is shared, not that the parts count together, in the dialog of an alternative", () => {
    render(
      <TargetHint
        input={alternative.input}
        groupId="g-7a"
        subjectId="s-sva"
        fields={fields({ lessonsPerWeek: "4", minutesPerLesson: "50" })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("target.hintTogether(Svenska)");
    expect(screen.getByRole("status")).not.toHaveTextContent("target.hintParts");
  });
});
