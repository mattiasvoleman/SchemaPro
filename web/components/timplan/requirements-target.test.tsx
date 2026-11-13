import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  cellSentence,
  GroupTotalCell,
  TargetCellBody,
  TargetHint,
  TargetHost,
  targetCellClass,
} from "@/components/timplan/requirements-target";
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
// TargetHost's two reads: the year follows this file's one plan.
vi.mock("@/lib/year-timplan-queries", () => ({
  useYearTimplans: () => ({
    data: [{ gradeLevel: 7, localTimplanId: "p", planName: "Grundskola 2026", planStatus: "DECIDED" }],
    isError: false,
  }),
  useLocalTimplanDetails: () => ({ data: plans, isError: false }),
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
  return { input, view: buildTargetView(computePlannedCoverage(input), plans, input.subjects) };
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

  // Review of #297, round 3 (LÅG-1): a part with no post in a class whose plan has the line was a plain "+", the red warning
  // that Mål mode is for missing from it, and a screen reader heard only the cell's name.
  it("paints a part without a post in the line's tone, and says what the plan asks of the line", () => {
    // No post at all: the plan's 65 on Slöjd is unplanned, and every part's empty cell says so, naming Slöjd, where the plan has it.
    const bare = viewOf([]);
    for (const subject of ["s-tx", "s-tm"]) {
      const cell = bare.view.cell("g-7a", subject)!;
      expect(cell, subject).toMatchObject({ planned: 0, tone: "unplanned", national: true, linePlanned: 0, lineTarget: 65, partnerSubjectIds: ["s-sl"] });
      expect(cellSentence(identity, cell, bare.input), subject).toBe("target.cellUnplanned(0|65|65|-65) target.cellParts(Slöjd)");
      expect(targetCellClass(cell.tone), subject).toContain("border-destructive");
    }
    // A line that is short, not empty, is amber in the part nobody has posted (Trä- och metallslöjd, beside a textil post of 40).
    const short = viewOf([row("r-tx", "s-tx", 1, 40)]).view.cell("g-7a", "s-tm")!;
    expect(short).toMatchObject({ planned: 0, tone: "under", linePlanned: 40, lineTarget: 65 });
    expect(targetCellClass(short.tone)).toContain("bg-warning/15");
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

// Ämne on the matrix: the classes' line and the total column hold one subject.
describe("one subject in Mål mode", () => {
  // Svenska 4 × 50 meets the 200 SvA shares, over 43 weeks: 143,3 h.
  const svenska = sourcesWith([row("r-sv", "s-sv", 4, 50)]);
  const { view } = viewOf([row("r-sv", "s-sv", 4, 50)]);

  it("states the subject's total over the classes and names it", () => {
    render(<TargetHost academicYearId="y1" sources={svenska} onState={() => {}} subject={{ id: "s-sv", name: "Svenska" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("target.totalSubject(Svenska|200|200|143,3 h|143,3 h)");
  });

  it("says SvA is counted with Svenska rather than 0 of a target the class meets through Svenska", () => {
    render(
      <TargetHost
        academicYearId="y1"
        sources={svenska}
        onState={() => {}}
        subject={{ id: "s-sva", name: "Svenska som andraspråk" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "target.totalSubjectCountedWith(Svenska som andraspråk|Svenska)",
    );
    // The total column of the classes' row says the same in a dash, as SvA's column total does.
    const { container } = render(<GroupTotalCell summary={null} total={view.subjectOwn("s-sva")!.total} />);
    expect(container).toHaveTextContent("—target.totalCountedWith");
    expect(container).not.toHaveTextContent("0 /");
  });

  it("keeps the whole classes' line without a subject", () => {
    render(<TargetHost academicYearId="y1" sources={svenska} onState={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent(/^target\.total\(/);
  });
});

// Review #297, MEDEL-1: what the total column and the classes' line say of a
// subject that is not teaching time, and of a part of a national line.
describe("a subject Mål mode has no figures of its own for", () => {
  it("says a subject that is not teaching time has none, behind a dash", () => {
    const { container } = render(
      <GroupTotalCell summary={null} total={{ planned: 0, target: null, plannedHours: 0, targetHours: null, notCounted: true }} />,
    );
    expect(container).toHaveTextContent("—target.totalNotCounted");
    expect(container).not.toHaveTextContent("0 /");
  });

  it("names the line under a part's figures, which are the line's", () => {
    // Textilslöjd 1 × 40 of the 65 on Slöjd, over 43 weeks.
    const { view } = viewOf([row("r-tx", "s-tx", 1, 40)]);
    const textil = view.subjectOwn("s-tx")!;
    const { container } = render(<GroupTotalCell summary={null} total={textil.row("g-7a")} />);
    expect(container).toHaveTextContent("40 / 6528,7 h / 46,6 htarget.totalLine(SL)");
  });

  it("says in the classes' line which line a part is counted on, and with which subjects", () => {
    render(
      <TargetHost
        academicYearId="y1"
        sources={sourcesWith([row("r-tx", "s-tx", 1, 40)])}
        onState={() => {}}
        subject={{ id: "s-tx", name: "Textilslöjd" }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "target.subjectLine(Textilslöjd|Slöjd|SL) target.lineFigures(40|65|28,7 h|46,6 h)",
    );
  });

  it("says a line no class has a target for has none, naming the line", () => {
    // The plan's entries are for åk 7; a class in åk 8 has the parts and no target.
    const sources = { ...sourcesWith([row("r-tx", "s-tx", 1, 40)]), groups: [{ id: "g-7a", name: "8A", kind: "CLASS" as const, gradeLevel: 8 }] };
    render(<TargetHost academicYearId="y1" sources={sources} onState={() => {}} subject={{ id: "s-tx", name: "Textilslöjd" }} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "target.subjectLineAlone(Textilslöjd|SL) target.lineFiguresNoTarget(40|28,7 h)",
    );
  });

  it("says Mentorstid and the like are not teaching time", () => {
    const sources = {
      ...sourcesWith([row("r-mt", "s-mt", 1, 30)]),
      subjects: [...subjects, { id: "s-mt", name: "Mentorstid", nationalCode: null, countsTowardTimplan: false }],
    };
    render(<TargetHost academicYearId="y1" sources={sources} onState={() => {}} subject={{ id: "s-mt", name: "Mentorstid" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("target.totalSubjectNotCounted(Mentorstid)");
  });
});
