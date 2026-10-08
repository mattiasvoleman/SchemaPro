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
  generate: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock("@/lib/queries", () => ({
  useRequirements: () => ({ data: state.requirements }),
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
