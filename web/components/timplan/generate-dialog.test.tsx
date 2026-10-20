import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerateBody, GenerateRequirementsResponse } from "@/lib/timplan-generate";
import type { AcademicYear } from "@/lib/types";
import { GenerateDialog } from "./generate-dialog";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * "Skapa timplansposter": preview before apply, the suggested length, the
 * edited rows sent as overrides and only those. What a proposal contains is
 * the gateway's (generate-requirements.spec.ts); here the gateway is a stub
 * answering the 175 → 3 × 60 (+5) example.
 */

const state = vi.hoisted(() => ({
  requirements: [] as { minutesPerLesson: number }[],
  groups: [] as { id: string; academicYearId: string; name: string; kind: string; gradeLevel: number | null }[],
  generate: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock("@/lib/queries", () => ({
  useRequirements: () => ({ data: state.requirements }),
  useGroups: () => ({ data: state.groups }),
}));
vi.mock("@/lib/timplan-queries", () => ({
  useGenerateRequirements: () => state.generate,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const YEARS: AcademicYear[] = [
  { id: "y-1", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: null, graduatingGradeLevel: null },
];
const PLAN = { id: "p-1", name: "Grundskola 2026", status: "DECIDED" as const };

/**
 * The gateway's SPLIT rule for the targets this stub knows (on the grid, under
 * 240 per lesson): a remainder over half a lesson, or beside a single lesson,
 * is a lesson of its own; a shorter one beside two or more is folded into one
 * longer lesson; under one lesson is one lesson of the target
 * (generate-requirements.ts).
 */
function splitOf(target: number, length: number): number[] | null {
  const whole = Math.floor(target / length);
  const rest = target - whole * length;
  if (rest === 0) return null;
  if (whole === 0) return [Math.max(target, 15)];
  const lengths =
    rest >= 15 && (rest > length / 2 || whole === 1)
      ? [...Array.from({ length: whole }, () => length), rest]
      : [...Array.from({ length: whole - 1 }, () => length), length + rest];
  return lengths.sort((a, b) => b - a);
}

const DEFAULT_TARGETS = [
  { subjectId: "s-ma", subjectName: "Matematik", target: 175 },
  { subjectId: "s-sv", subjectName: "Svenska", target: 200 },
];

function answer(
  body: GenerateBody & { planId: string },
  targets: { subjectId: string; subjectName: string; target: number }[] = DEFAULT_TARGETS,
): GenerateRequirementsResponse {
  const created = body.dryRun ? 0 : targets.length;
  const rows = targets.map(({ subjectId, subjectName, target }) => {
    const override = body.overrides?.find((entry) => entry.subjectId === subjectId);
    const split = !override && body.remainder === "SPLIT" ? splitOf(target, body.minutesPerLesson) : null;
    if (split) {
      return {
        studentGroupId: "g-7a",
        groupName: "7A",
        subjectId,
        subjectName,
        gradeLevel: 7,
        targetMinutesPerWeek: target,
        lessonsPerWeek: split.length,
        minutesPerLesson: split[0],
        ...(new Set(split).size > 1 ? { lessonLengths: split } : {}),
        plannedMinutesPerWeek: target,
        surplusMinutesPerWeek: 0,
        overridden: false,
        capped: false,
      };
    }
    const minutes = override?.minutesPerLesson ?? body.minutesPerLesson;
    const lessons = override?.lessonsPerWeek ?? Math.ceil(target / minutes);
    return {
      studentGroupId: "g-7a",
      groupName: "7A",
      subjectId,
      subjectName,
      gradeLevel: 7,
      targetMinutesPerWeek: target,
      lessonsPerWeek: lessons,
      minutesPerLesson: minutes,
      plannedMinutesPerWeek: lessons * minutes,
      surplusMinutesPerWeek: lessons * minutes - target,
      overridden: override !== undefined,
      capped: false,
    };
  });
  return {
    localTimplanId: body.planId,
    planName: PLAN.name,
    planStatus: "DECIDED",
    academicYearId: body.academicYearId,
    gradeLevels: [7],
    minutesPerLesson: body.minutesPerLesson,
    ...(body.remainder !== undefined ? { remainder: body.remainder } : {}),
    dryRun: body.dryRun,
    created,
    rows,
    skipped: [
      {
        studentGroupId: "g-7a",
        groupName: "7A",
        subjectId: "s-en",
        subjectName: "Engelska",
        gradeLevel: 7,
        reason: "EXISTS",
        alternativeCode: null,
        alternativeTo: null,
      },
    ],
  };
}

const renderDialog = (plan: { id: string; name: string; status: "DRAFT" | "DECIDED" } = PLAN) =>
  render(<GenerateDialog open onOpenChange={() => {}} plan={plan} years={YEARS} initialYearId={null} />);

beforeEach(() => {
  state.requirements = [];
  state.groups = [];
  state.generate = {
    mutateAsync: vi.fn(async (body: GenerateBody & { planId: string }) => answer(body)),
    isPending: false,
  };
});

describe("GenerateDialog", () => {
  it("suggests 60 for a year without posts, and the year's most common length otherwise", () => {
    const { unmount } = renderDialog();
    expect(screen.getByLabelText("lengthLabel")).toHaveValue("60");
    expect(screen.getByText("lengthHintDefault(60)")).toBeInTheDocument();
    unmount();

    state.requirements = [{ minutesPerLesson: 50 }, { minutesPerLesson: 50 }, { minutesPerLesson: 60 }];
    renderDialog();
    expect(screen.getByLabelText("lengthLabel")).toHaveValue("50");
    expect(screen.getByText("lengthHintCommon(50)")).toBeInTheDocument();
  });

  it("creates nothing before a preview, and previews with dryRun true", async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByRole("button", { name: /^apply/ })).toBeDisabled();

    // Whole lessons, rounded up: today's rule and today's body, no remainder.
    await user.click(screen.getByRole("button", { name: "preview" }));
    expect(state.generate.mutateAsync).toHaveBeenCalledWith({
      planId: "p-1",
      academicYearId: "y-1",
      minutesPerLesson: 60,
      dryRun: true,
    });
    expect(await screen.findByText("summary(2|1|1|grade(7))")).toBeInTheDocument();
    const ma = screen.getByRole("row", { name: /Matematik/ });
    expect(within(ma).getByText("+5")).toBeInTheDocument();
    expect(screen.getByText("skippedRow(7A|Engelska)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "apply(2)" })).toBeEnabled();
  });

  it("says why språkval and SvA are not created on the class, and counts only existing pairs as existing", async () => {
    state.generate.mutateAsync = vi.fn(async (body: GenerateBody & { planId: string }) => {
      const base = answer(body);
      const where = { studentGroupId: "g-7a", groupName: "7A", gradeLevel: 7, reason: "ALTERNATIVE" as const };
      return {
        ...base,
        skipped: [
          ...base.skipped,
          { ...where, subjectId: "s-es", subjectName: "Spanska", alternativeCode: "M2", alternativeTo: null },
          { ...where, subjectId: "s-sva", subjectName: "Svenska som andraspråk", alternativeCode: "SV_SVA", alternativeTo: "Svenska" },
        ],
      };
    });
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "preview" }));
    // One pair exists; the two alternatives are not "already existing".
    expect(await screen.findByText("summary(2|1|1|grade(7))")).toBeInTheDocument();
    expect(screen.getByText("alternativesNote")).toBeInTheDocument();
    expect(screen.getByText("skippedTitle(3)")).toBeInTheDocument();
    expect(screen.getByText("skippedLanguage(7A|Spanska)")).toBeInTheDocument();
    expect(screen.getByText("skippedAlternative(7A|Svenska som andraspråk|Svenska)")).toBeInTheDocument();
  });

  it("throws the preview away when the length changes", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "preview" }));
    await screen.findByText(/^summary/);
    await user.clear(screen.getByLabelText("lengthLabel"));
    await user.type(screen.getByLabelText("lengthLabel"), "45");
    expect(screen.queryByText(/^summary/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^apply/ })).toBeDisabled();
  });

  it("refuses a length off the five-minute grid before asking the gateway", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.clear(screen.getByLabelText("lengthLabel"));
    await user.type(screen.getByLabelText("lengthLabel"), "47");
    expect(screen.getByText("length.grid")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "preview" })).toBeDisabled();
  });

  it("sends the edited row as an override, and only that row, then shows what was created", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "preview" }));
    await screen.findByText(/^summary/);

    const lessons = screen.getByLabelText("lessonsFor(7A Matematik)");
    const minutes = screen.getByLabelText("minutesFor(7A Matematik)");
    await user.clear(lessons);
    await user.type(lessons, "5");
    await user.clear(minutes);
    await user.type(minutes, "35");
    // 5 × 35 = 175: exactly the target.
    expect(within(screen.getByRole("row", { name: /Matematik/ })).getByText("0")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "apply(2)" }));
    expect(state.generate.mutateAsync).toHaveBeenLastCalledWith({
      planId: "p-1",
      academicYearId: "y-1",
      minutesPerLesson: 60,
      dryRun: false,
      overrides: [{ studentGroupId: "g-7a", subjectId: "s-ma", lessonsPerWeek: 5, minutesPerLesson: 35 }],
    });
    expect(await screen.findByText("resultCreated(2|2026/27)")).toBeInTheDocument();
    expect(screen.getByText("resultSkipped(1)")).toBeInTheDocument();
    // The result link opens the year the posts were made in, not the active one.
    expect(screen.getByRole("link", { name: "openRequirements" })).toHaveAttribute("href", "/admin/requirements?year=y-1");
  });

  it("will not apply while an edited row holds a figure the gateway refuses", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "preview" }));
    await screen.findByText(/^summary/);
    const lessons = screen.getByLabelText("lessonsFor(7A Svenska)");
    await user.clear(lessons);
    await user.type(lessons, "41");
    expect(screen.getByRole("alert")).toHaveTextContent("invalidRows");
    expect(screen.getByRole("button", { name: "apply(2)" })).toBeDisabled();
  });

  describe("lektionslängder: dela upp resten", () => {
    it("starts unchecked, so a school that never splits sends today's body and sees today's rows", async () => {
      const user = userEvent.setup();
      renderDialog();
      expect(screen.getByLabelText("splitLabel")).not.toBeChecked();
      expect(screen.getByText("roundUpHint")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "preview" }));
      const body = state.generate.mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(body).not.toHaveProperty("remainder");
      await screen.findByText(/^summary/);
      expect(screen.queryByText(/^splitNote/)).toBeNull();
      expect(screen.queryByRole("button", { name: /^makeUniformFor/ })).toBeNull();
      expect(screen.getByText("surplusHint")).toBeInTheDocument();
    });

    it("asks for SPLIT once checked and shows each split row as its lengths, at no surplus", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByLabelText("splitLabel"));
      expect(screen.getByText("splitHint")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "preview" }));
      expect(state.generate.mutateAsync).toHaveBeenCalledWith({
        planId: "p-1",
        academicYearId: "y-1",
        minutesPerLesson: 60,
        remainder: "SPLIT",
        dryRun: true,
      });
      const ma = await screen.findByRole("row", { name: /Matematik/ });
      // 175 at 60: 2 × 60 + 1 × 55, and 200 at 60 folds into 2 × 60 + 1 × 80.
      expect(within(ma).getByText("2 × 60 + 1 × 55")).toBeInTheDocument();
      expect(within(ma).getByText("0")).toBeInTheDocument();
      expect(within(ma).queryByLabelText("lessonsFor(7A Matematik)")).toBeNull();
      expect(within(screen.getByRole("row", { name: /Svenska/ })).getByText("1 × 80 + 2 × 60")).toBeInTheDocument();
      expect(screen.getByText("splitNote(2)")).toBeInTheDocument();
      expect(screen.getByText("surplusHintSplit")).toBeInTheDocument();
    });

    it("applies the split rows as the gateway proposed them: no overrides", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByLabelText("splitLabel"));
      await user.click(screen.getByRole("button", { name: "preview" }));
      await screen.findByText(/^summary/);
      await user.click(screen.getByRole("button", { name: "apply(2)" }));
      expect(state.generate.mutateAsync).toHaveBeenLastCalledWith({
        planId: "p-1",
        academicYearId: "y-1",
        minutesPerLesson: 60,
        remainder: "SPLIT",
        dryRun: false,
      });
    });

    it("makes one row uniform at the round-up post, sends it as an override, and can split it again", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByLabelText("splitLabel"));
      await user.click(screen.getByRole("button", { name: "preview" }));
      await screen.findByText(/^summary/);

      await user.click(screen.getByRole("button", { name: "makeUniformFor(7A Matematik)" }));
      const ma = screen.getByRole("row", { name: /Matematik/ });
      // ceil(175 / 60) = 3 × 60: equal to the split row's count and longest,
      // and still an override, because the row it replaces is split.
      expect(within(ma).getByLabelText("lessonsFor(7A Matematik)")).toHaveValue("3");
      expect(within(ma).getByLabelText("minutesFor(7A Matematik)")).toHaveValue("60");
      expect(within(ma).getByText("+5")).toBeInTheDocument();
      expect(within(ma).getByText("edited")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "splitAgainFor(7A Matematik)" }));
      expect(within(screen.getByRole("row", { name: /Matematik/ })).getByText("2 × 60 + 1 × 55")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "makeUniformFor(7A Matematik)" }));
      await user.click(screen.getByRole("button", { name: "apply(2)" }));
      expect(state.generate.mutateAsync).toHaveBeenLastCalledWith({
        planId: "p-1",
        academicYearId: "y-1",
        minutesPerLesson: 60,
        remainder: "SPLIT",
        dryRun: false,
        overrides: [{ studentGroupId: "g-7a", subjectId: "s-ma", lessonsPerWeek: 3, minutesPerLesson: 60 }],
      });
    });

    it("throws the preview away when the remainder changes", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByLabelText("splitLabel"));
      await user.click(screen.getByRole("button", { name: "preview" }));
      await screen.findByText(/^summary/);
      await user.click(screen.getByLabelText("splitLabel"));
      expect(screen.queryByText(/^summary/)).not.toBeInTheDocument();
      expect(screen.getByText("roundUpHint")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^apply/ })).toBeDisabled();
    });

    it("flags a row SPLIT made uniform at another length — 45 at 60 as 1 × 45 — as it flags a split row", async () => {
      // isMixed cannot see 1 × 45; it is still not the 1 × 60 whole lessons give.
      state.generate.mutateAsync = vi.fn(async (body: GenerateBody & { planId: string }) =>
        answer(body, [
          { subjectId: "s-ma", subjectName: "Matematik", target: 180 },
          { subjectId: "s-mu", subjectName: "Musik", target: 45 },
        ]),
      );
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByLabelText("splitLabel"));
      await user.click(screen.getByRole("button", { name: "preview" }));
      const mu = await screen.findByRole("row", { name: /Musik/ });
      expect(within(mu).getByText("1 × 45")).toBeInTheDocument();
      expect(within(mu).queryByLabelText("lessonsFor(7A Musik)")).toBeNull();
      // Matematik 180 is 3 × 60 either way: not flagged.
      expect(screen.queryByRole("button", { name: "makeUniformFor(7A Matematik)" })).toBeNull();
      expect(screen.getByText("splitNote(1)")).toBeInTheDocument();
      expect(screen.getByText("surplusHintSplit")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "makeUniformFor(7A Musik)" }));
      expect(screen.getByLabelText("lessonsFor(7A Musik)")).toHaveValue("1");
      expect(screen.getByLabelText("minutesFor(7A Musik)")).toHaveValue("60");
      expect(screen.getByRole("button", { name: "splitAgainFor(7A Musik)" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "apply(2)" }));
      expect(state.generate.mutateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({
          remainder: "SPLIT",
          overrides: [{ studentGroupId: "g-7a", subjectId: "s-mu", lessonsPerWeek: 1, minutesPerLesson: 60 }],
        }),
      );
    });

    it("drops the note and the split footer once every changed row is made uniform", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByLabelText("splitLabel"));
      await user.click(screen.getByRole("button", { name: "preview" }));
      await screen.findByText("splitNote(2)");
      await user.click(screen.getByRole("button", { name: "makeUniformFor(7A Matematik)" }));
      expect(screen.getByText("splitNote(1)")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "makeUniformFor(7A Svenska)" }));
      expect(screen.queryByText(/^splitNote/)).toBeNull();
      expect(screen.queryByText("surplusHintSplit")).toBeNull();
      expect(screen.getByText("surplusHint")).toBeInTheDocument();
    });

    it("keeps focus in the row: Gör enhetlig moves it to the lessons field, Dela upp igen back to Gör enhetlig", async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByLabelText("splitLabel"));
      await user.click(screen.getByRole("button", { name: "preview" }));
      await screen.findByText(/^summary/);
      await user.click(screen.getByRole("button", { name: "makeUniformFor(7A Matematik)" }));
      expect(screen.getByLabelText("lessonsFor(7A Matematik)")).toHaveFocus();
      await user.click(screen.getByRole("button", { name: "splitAgainFor(7A Matematik)" }));
      expect(screen.getByRole("button", { name: "makeUniformFor(7A Matematik)" })).toHaveFocus();
      // The keyboard path too.
      await user.keyboard("{Enter}");
      expect(screen.getByLabelText("lessonsFor(7A Matematik)")).toHaveFocus();
    });
  });

  it("says so when no årskurs of the year follows the plan", async () => {
    const user = userEvent.setup();
    state.generate.mutateAsync = vi.fn(async (body: GenerateBody & { planId: string }) => ({
      ...answer(body),
      gradeLevels: [],
      rows: [],
      skipped: [],
    }));
    renderDialog();
    await user.click(screen.getByRole("button", { name: "preview" }));
    expect(await screen.findByText("noGrades(2026/27|Grundskola 2026)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^apply/ })).toBeDisabled();
  });

  it("marks a draft plan before anything is created from it", () => {
    renderDialog({ ...PLAN, status: "DRAFT" });
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("shows the gateway's refusal and stays open", async () => {
    const user = userEvent.setup();
    state.generate.mutateAsync = vi.fn(async () => {
      throw new Error("Läsåret finns inte.");
    });
    renderDialog();
    await user.click(screen.getByRole("button", { name: "preview" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Läsåret finns inte.");
  });
});

describe("GenerateDialog: språkval as a block", () => {
  const entries = [
    { subjectId: "s-ma", gradeLevel: 7, minutesPerWeek: 175 },
    { subjectId: "s-de", gradeLevel: 7, minutesPerWeek: 120 },
    { subjectId: "s-es", gradeLevel: 7, minutesPerWeek: 120 },
    { subjectId: "s-de", gradeLevel: 9, minutesPerWeek: 120 },
    { subjectId: "s-fr", gradeLevel: 7, minutesPerWeek: 0 },
  ];
  const subjects = [
    { id: "s-ma", name: "Matematik", nationalCode: "MA" },
    { id: "s-de", name: "Tyska", nationalCode: "M2" },
    { id: "s-es", name: "Spanska", nationalCode: "M2" },
    { id: "s-fr", name: "Franska", nationalCode: "M2" },
  ];
  const renderWithPlan = () =>
    render(
      <GenerateDialog
        open
        onOpenChange={() => {}}
        plan={PLAN}
        years={YEARS}
        initialYearId={null}
        entries={entries}
        subjects={subjects}
      />,
    );

  /** Picks a group in the language's select and commits it with Lägg till. */
  const choose = async (user: ReturnType<typeof userEvent.setup>, language: string, groupId: string) => {
    await user.selectOptions(await screen.findByLabelText(`languageLabel(${language})`), groupId);
    await user.click(screen.getByRole("button", { name: `languageAdd(languageLabel(${language}))` }));
  };

  beforeEach(() => {
    state.groups = [
      { id: "g-7a", academicYearId: "y-1", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-ty7", academicYearId: "y-1", name: "Ty7", kind: "TEACHING_GROUP", gradeLevel: 7 },
      { id: "g-sp7", academicYearId: "y-1", name: "Sp7", kind: "TEACHING_GROUP", gradeLevel: 7 },
      { id: "g-old", academicYearId: "y-0", name: "Ty7 förra året", kind: "TEACHING_GROUP", gradeLevel: 7 },
    ];
    state.generate.mutateAsync = vi.fn(async (body: GenerateBody & { planId: string }) => {
      const base = answer(body);
      const rows = (body.languageGroups ?? []).map((choice) => ({
        studentGroupId: choice.studentGroupId,
        groupName: state.groups.find((group) => group.id === choice.studentGroupId)?.name ?? choice.studentGroupId,
        subjectId: choice.subjectId,
        subjectName: choice.subjectId === "s-de" ? "Tyska" : "Spanska",
        gradeLevel: 7,
        targetMinutesPerWeek: 120,
        lessonsPerWeek: 2,
        minutesPerLesson: 60,
        plannedMinutesPerWeek: 120,
        surplusMinutesPerWeek: 0,
        overridden: false,
        capped: false,
        blockName: "Språkval åk 7",
      }));
      return {
        ...base,
        rows: [...base.rows, ...rows],
        ...(rows.length > 0 ? { blocks: [{ name: "Språkval åk 7", gradeLevel: 7 }] } : {}),
      };
    });
  });

  it("offers the year's teaching groups for each M2 language of the årskurser the preview found, and nothing before", async () => {
    const user = userEvent.setup();
    renderWithPlan();
    expect(screen.queryByText("languagesTitle")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "preview" }));
    await screen.findByText("languagesTitle");
    // Åk 9 is not attached to this year (gradeLevels [7]); Franska has no minutes.
    expect(screen.getByLabelText("languageLabel(Spanska|7)")).toBeInTheDocument();
    expect(screen.getByLabelText("languageLabel(Tyska|7)")).toBeInTheDocument();
    expect(screen.queryByLabelText("languageLabel(Tyska|9)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("languageLabel(Franska|7)")).not.toBeInTheDocument();
    const options = within(screen.getByLabelText("languageLabel(Tyska|7)")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["languagePick", "Ty7", "Sp7"]);
  });

  it("asks a new preview with the groups chosen, shows the block on its rows without an edit, and applies them", async () => {
    const user = userEvent.setup();
    renderWithPlan();
    await user.click(screen.getByRole("button", { name: "preview" }));
    await choose(user, "Tyska|7", "g-ty7");
    await choose(user, "Spanska|7", "g-sp7");
    // The preview on screen was asked without them.
    expect(screen.getByRole("button", { name: /^apply/ })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "preview" }));
    const languageGroups = [
      { gradeLevel: 7, subjectId: "s-de", studentGroupId: "g-ty7" },
      { gradeLevel: 7, subjectId: "s-es", studentGroupId: "g-sp7" },
    ];
    expect(state.generate.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ dryRun: true, languageGroups }),
    );
    const tyska = await screen.findByRole("row", { name: /Ty7/ });
    expect(within(tyska).getByText("Språkval åk 7")).toBeInTheDocument();
    expect(within(tyska).queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^apply/ }));
    expect(state.generate.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ dryRun: false, languageGroups }),
    );
    expect(await screen.findByText("resultBlocks(Språkval åk 7)")).toBeInTheDocument();
  });

  describe("several groups for one language", () => {
    beforeEach(() => {
      state.groups = [
        ...state.groups,
        { id: "g-sp7b", academicYearId: "y-1", name: "7sp2", kind: "TEACHING_GROUP", gradeLevel: 7 },
        { id: "g-sp7c", academicYearId: "y-1", name: "7sp3", kind: "TEACHING_GROUP", gradeLevel: 7 },
      ];
    });

    it("adds each with Lägg till, lists them, and offers a chosen group to no other language", async () => {
      const user = userEvent.setup();
      renderWithPlan();
      await user.click(screen.getByRole("button", { name: "preview" }));
      await choose(user, "Spanska|7", "g-sp7");
      await choose(user, "Spanska|7", "g-sp7b");
      await choose(user, "Spanska|7", "g-sp7c");

      const chosen = screen.getByRole("list", { name: "languageChosen(languageLabel(Spanska|7))" });
      expect(within(chosen).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Sp7", "7sp2", "7sp3"]);
      // Focus is back on the select, on its prompt, for the next group.
      const spanska = screen.getByLabelText("languageLabel(Spanska|7)");
      expect(spanska).toHaveFocus();
      expect(spanska).toHaveValue("");
      expect(screen.getByText("languageAdded(7sp3|languageLabel(Spanska|7))")).toBeInTheDocument();
      expect(within(spanska).getAllByRole("option").map((option) => option.textContent)).toEqual(["languagePick", "Ty7"]);
      // A group reads one language: Tyska no longer offers the Spanska groups.
      expect(
        within(screen.getByLabelText("languageLabel(Tyska|7)")).getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["languagePick", "Ty7"]);

      await user.click(screen.getByRole("button", { name: "preview" }));
      expect(state.generate.mutateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dryRun: true,
          languageGroups: [
            { gradeLevel: 7, subjectId: "s-es", studentGroupId: "g-sp7" },
            { gradeLevel: 7, subjectId: "s-es", studentGroupId: "g-sp7b" },
            { gradeLevel: 7, subjectId: "s-es", studentGroupId: "g-sp7c" },
          ],
        }),
      );
      // Three rows of one language in the block, counted as three groups.
      for (const name of ["Sp7", "7sp2", "7sp3"]) {
        const row = await screen.findByRole("row", { name: new RegExp(`${name}.*Spanska`) });
        expect(within(row).getByText("Språkval åk 7")).toBeInTheDocument();
      }
      expect(screen.getByRole("status")).toHaveTextContent("summaryLanguages(3|3|Språkval åk 7)");
    });

    it("adds nothing when a group is only picked, so arrowing through the select adds nothing", async () => {
      const user = userEvent.setup();
      renderWithPlan();
      await user.click(screen.getByRole("button", { name: "preview" }));
      const add = screen.getByRole("button", { name: "languageAdd(languageLabel(Spanska|7))" });
      expect(add).toBeDisabled();

      await user.selectOptions(screen.getByLabelText("languageLabel(Spanska|7)"), "g-sp7");
      await user.selectOptions(screen.getByLabelText("languageLabel(Spanska|7)"), "g-sp7b");
      expect(screen.queryByRole("list", { name: /^languageChosen/ })).toBeNull();
      expect(add).toBeEnabled();
      // Nothing chosen, so the preview on screen still holds.
      expect(screen.getByRole("button", { name: /^apply/ })).toBeEnabled();
    });

    it("takes a group off, moving focus to the next group, else the previous, else the select", async () => {
      const user = userEvent.setup();
      renderWithPlan();
      await user.click(screen.getByRole("button", { name: "preview" }));
      await choose(user, "Spanska|7", "g-sp7");
      await choose(user, "Spanska|7", "g-sp7b");
      await choose(user, "Spanska|7", "g-sp7c");
      const chosen = screen.getByRole("list", { name: "languageChosen(languageLabel(Spanska|7))" });

      await user.click(screen.getByRole("button", { name: "languageRemove(7sp2|languageLabel(Spanska|7))" }));
      expect(within(chosen).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Sp7", "7sp3"]);
      expect(screen.getByRole("button", { name: "languageRemove(7sp3|languageLabel(Spanska|7))" })).toHaveFocus();
      expect(screen.getByText("languageRemoved(7sp2|languageLabel(Spanska|7))")).toBeInTheDocument();
      // Offered again, to every language.
      expect(within(screen.getByLabelText("languageLabel(Tyska|7)")).getByRole("option", { name: "7sp2" })).toBeInTheDocument();

      await user.keyboard("{Enter}");
      expect(screen.getByRole("button", { name: "languageRemove(Sp7|languageLabel(Spanska|7))" })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("list", { name: /^languageChosen/ })).toBeNull();
      expect(screen.getByLabelText("languageLabel(Spanska|7)")).toHaveFocus();
    });

    it("keeps the preview when the same groups are chosen again in another order", async () => {
      const user = userEvent.setup();
      renderWithPlan();
      await user.click(screen.getByRole("button", { name: "preview" }));
      await choose(user, "Spanska|7", "g-sp7");
      await choose(user, "Spanska|7", "g-sp7b");
      await user.click(screen.getByRole("button", { name: "preview" }));
      await screen.findByRole("row", { name: /7sp2/ });

      await user.click(screen.getByRole("button", { name: "languageRemove(Sp7|languageLabel(Spanska|7))" }));
      expect(screen.getByRole("button", { name: /^apply/ })).toBeDisabled();
      await choose(user, "Spanska|7", "g-sp7");
      // [7sp2, Sp7] is the set the preview was asked for: it holds.
      expect(screen.getByRole("button", { name: /^apply/ })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: /^apply/ }));
      expect(state.generate.mutateAsync).toHaveBeenLastCalledWith(
        expect.objectContaining({
          dryRun: false,
          languageGroups: [
            { gradeLevel: 7, subjectId: "s-es", studentGroupId: "g-sp7" },
            { gradeLevel: 7, subjectId: "s-es", studentGroupId: "g-sp7b" },
          ],
        }),
      );
    });

    it("drops a chosen group the year no longer has, and sends no languageGroups once the last is gone", async () => {
      const user = userEvent.setup();
      const view = renderWithPlan();
      await user.click(screen.getByRole("button", { name: "preview" }));
      await choose(user, "Spanska|7", "g-sp7b");
      expect(screen.getByRole("list", { name: "languageChosen(languageLabel(Spanska|7))" })).toHaveTextContent("7sp2");

      // Deleted elsewhere; the groups query refetches.
      state.groups = state.groups.filter((group) => group.id !== "g-sp7b");
      view.rerender(
        <GenerateDialog
          open
          onOpenChange={() => {}}
          plan={PLAN}
          years={YEARS}
          initialYearId={null}
          entries={entries}
          subjects={subjects}
        />,
      );
      expect(screen.queryByRole("list", { name: /^languageChosen/ })).toBeNull();
      // Back to what the preview on screen was asked with, so it holds again.
      await user.click(screen.getByRole("button", { name: /^apply/ }));
      expect(state.generate.mutateAsync).toHaveBeenLastCalledWith(
        expect.not.objectContaining({ languageGroups: expect.anything() }),
      );
    });
  });

  it("counts the classes' rows and the språkval rows apart: a language group is no class", async () => {
    const user = userEvent.setup();
    renderWithPlan();
    await user.click(screen.getByRole("button", { name: "preview" }));
    await choose(user, "Tyska|7", "g-ty7");
    await choose(user, "Spanska|7", "g-sp7");
    await user.click(screen.getByRole("button", { name: "preview" }));

    await screen.findByRole("row", { name: /Ty7/ });
    // Two rows on one class, and two on two språkval groups — not four rows on three classes.
    expect(screen.getByRole("status")).toHaveTextContent(
      "summary(2|1|1|grade(7)) summaryLanguages(2|2|Språkval åk 7)",
    );
  });

  it("says nothing of Gör enhetlig for a block's split rows, which offer none, but keeps the split footer", async () => {
    state.generate.mutateAsync = vi.fn(async (body: GenerateBody & { planId: string }) => {
      const base = answer(body, [{ subjectId: "s-ma", subjectName: "Matematik", target: 180 }]);
      return {
        ...base,
        rows: [
          ...base.rows,
          {
            studentGroupId: "g-ty7",
            groupName: "Ty7",
            subjectId: "s-de",
            subjectName: "Tyska",
            gradeLevel: 7,
            targetMinutesPerWeek: 120,
            lessonsPerWeek: 2,
            minutesPerLesson: 80,
            lessonLengths: [80, 40],
            plannedMinutesPerWeek: 120,
            surplusMinutesPerWeek: 0,
            overridden: false,
            capped: false,
            blockName: "Språkval åk 7",
          },
        ],
        blocks: [{ name: "Språkval åk 7", gradeLevel: 7 }],
      };
    });
    const user = userEvent.setup();
    renderWithPlan();
    await user.click(screen.getByLabelText("splitLabel"));
    await user.click(screen.getByRole("button", { name: "preview" }));

    const tyska = await screen.findByRole("row", { name: /Ty7/ });
    expect(within(tyska).getByText("1 × 80 + 1 × 40")).toBeInTheDocument();
    expect(within(tyska).queryByRole("button")).toBeNull();
    expect(screen.queryByText(/^splitNote/)).toBeNull();
    expect(screen.getByText("surplusHintSplit")).toBeInTheDocument();
  });

  it("sends no languageGroups while no group is chosen", async () => {
    const user = userEvent.setup();
    renderWithPlan();
    await user.click(screen.getByRole("button", { name: "preview" }));
    await screen.findByText("languagesTitle");
    await user.click(screen.getByRole("button", { name: /^apply/ }));

    expect(state.generate.mutateAsync).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ languageGroups: expect.anything() }),
    );
  });
});
