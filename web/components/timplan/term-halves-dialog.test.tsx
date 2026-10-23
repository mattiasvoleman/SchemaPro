import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { TeachingRequirement } from "@/lib/types";
import {
  TermHalvesDialog,
  guessTermSubjects,
  proposedSpringStart,
  springStartFits,
  type TermHalvesDialogProps,
} from "./term-halves-dialog";

/**
 * Dela terminsvis i halvklass. What the gateway writes, refuses and judges is
 * term-halves.service.spec.ts's; here the POST is recorded and answered, and
 * the dialog is held to what it sends, what it draws before it sends, and
 * what it says when the gateway says no.
 */

const state = vi.hoisted(() => ({
  post: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post: state.post },
}));
vi.mock("sonner", () => ({ toast: { success: state.success, warning: state.warning, error: state.error } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values ? `${key}(${Object.values(values).join("|")})` : key,
      { has: () => true },
    ),
}));

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const post = (extra: Partial<TeachingRequirement> = {}) =>
  ({
    id: "r-sl",
    academicYearId: "y1",
    subjectId: "s-sl",
    studentGroupId: "g-7a",
    teacherId: null,
    coTeacherId: null,
    lessonsPerWeek: 2,
    minutesPerLesson: 60,
    minutesBefore: 0,
    minutesAfter: 0,
    teacherLoadPercent: 100,
    coTeacherLoadPercent: 100,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    blockId: null,
    ...extra,
  }) as TeachingRequirement;
const subjects = [
  { id: "s-sl", name: "Slöjd" },
  { id: "s-tm", name: "Trä- och metallslöjd" },
  { id: "s-tx", name: "Textilslöjd" },
  { id: "s-ma", name: "Matematik" },
];
const teachers = [
  { id: "t-anna", firstName: "Anna", lastName: "Ek" },
  { id: "t-bo", firstName: "Bo", lastName: "Al" },
  { id: "t-cecilia", firstName: "Cecilia", lastName: "Ås" },
];
const classOnly = [{ id: "g-7a", name: "7A", halfOfId: null }];
const withHalves = [
  ...classOnly,
  { id: "h-2", name: "7A:2", halfOfId: "g-7a" },
  { id: "h-1", name: "7A:1", halfOfId: "g-7a" },
];

function renderDialog(props: Partial<TermHalvesDialogProps> = {}) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <TermHalvesDialog
        requirement={post()}
        groups={classOnly}
        subjects={subjects}
        teachers={teachers}
        year={YEAR}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose, invalidate, user: userEvent.setup(), dialog: within(screen.getByRole("dialog")) };
}

const submit = () => screen.getByRole("button", { name: "submit" }) as HTMLButtonElement;
/** The four posts as the table draws them: one row per half, autumn then spring. */
const plan = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent));

beforeEach(() => {
  state.post.mockReset().mockResolvedValue({ halves: [{ id: "h-1", name: "7A:1" }, { id: "h-2", name: "7A:2" }], warnings: [] });
  state.success.mockReset();
  state.warning.mockReset();
  state.error.mockReset();
});

describe("the proposals", () => {
  it("proposes the first Monday of the new year as the spring term's first day", () => {
    // 1 January 2027 is a Friday.
    expect(proposedSpringStart(YEAR)).toBe("2027-01-04");
    // 1 January 2029 is itself a Monday.
    expect(proposedSpringStart({ startDate: "2028-08-14", endDate: "2029-06-08" })).toBe("2029-01-01");
  });

  it("proposes nothing for a läsår that does not reach a new year, or no läsår", () => {
    expect(proposedSpringStart({ startDate: "2027-01-11", endDate: "2027-06-11" })).toBe("");
    expect(proposedSpringStart(null)).toBe("");
  });

  it("takes a spring start after the year's first day and by its last", () => {
    expect(springStartFits("2026-08-17", YEAR)).toBe(false);
    expect(springStartFits("2026-08-18", YEAR)).toBe(true);
    expect(springStartFits("2027-06-11", YEAR)).toBe(true);
    expect(springStartFits("2027-06-12", YEAR)).toBe(false);
    expect(springStartFits("", YEAR)).toBe(false);
  });

  it("guesses the two slöjd subjects, never the same one twice", () => {
    expect(guessTermSubjects(subjects)).toEqual(["s-tx", "s-tm"]);
    expect(guessTermSubjects([{ id: "a", name: "Syslöjd" }, { id: "b", name: "Trä och metall" }])).toEqual(["a", "b"]);
    expect(guessTermSubjects([{ id: "a", name: "Slöjd" }])).toEqual(["", ""]);
    // "Textil- och trälöjd" says both: it is the first, and no second is found.
    expect(guessTermSubjects([{ id: "a", name: "Textil- och träslöjd" }])).toEqual(["a", ""]);
  });
});

describe("TermHalvesDialog", () => {
  it("draws the four posts before anything is sent: each half one subject in the autumn and the other in the spring", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "title(7A · Slöjd)" })).toBeInTheDocument();
    // What is carried over is said: the lessons and both percentages.
    expect(screen.getByText("description(7A · Slöjd|lengthPart(2|60)|100|100)")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "halfColumn",
      "autumnUntil(3 januari)",
      "springFrom(4 januari)",
    ]);
    expect(plan()).toEqual([
      ["7A:1", "Textilslöjd", "Trä- och metallslöjd"],
      ["7A:2", "Trä- och metallslöjd", "Textilslöjd"],
    ]);
    expect(screen.getByText("replaces(7A · Slöjd)")).toBeInTheDocument();
    expect(screen.getByText("generatorNote")).toBeInTheDocument();
    expect(submit().disabled).toBe(false);
  });

  it("sends the subjects with their teachers, the spring's first day, the halves' and the blocks' names, and closes", async () => {
    const { user, onClose, invalidate } = renderDialog();

    await user.click(screen.getByRole("combobox", { name: /^teacherOf\(Textilslöjd\)/ }));
    await user.click(screen.getByRole("option", { name: "Anna Ek" }));
    await user.click(submit());

    expect(state.post).toHaveBeenCalledWith("/api/v1/teaching-requirements/r-sl/term-halves", {
      subjects: [
        { subjectId: "s-tx", teacherId: "t-anna", coTeacherId: null },
        { subjectId: "s-tm", teacherId: null, coTeacherId: null },
      ],
      springStartDate: "2027-01-04",
      halfNames: ["7A:1", "7A:2"],
      blockNames: ["blockAutumn(Slöjd|7A)", "blockSpring(Slöjd|7A)"],
    });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual(
      expect.arrayContaining([["requirements", "y1"], ["groups"], ["teachingBlocks", "y1"]]),
    );
    expect(state.success).toHaveBeenCalledWith("done(7A · Slöjd|7A:1|7A:2)");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("swaps the plan when the first half's autumn subject is changed", async () => {
    const { user } = renderDialog();

    await user.click(screen.getByRole("combobox", { name: "autumnSubject(7A:1)" }));
    await user.click(screen.getByRole("option", { name: "Matematik" }));

    expect(plan()).toEqual([
      ["7A:1", "Matematik", "Trä- och metallslöjd"],
      ["7A:2", "Trä- och metallslöjd", "Matematik"],
    ]);
  });

  it("uses the halves the class has, by name, and sends them in the order it drew, not their names", async () => {
    const { user } = renderDialog({ groups: withHalves });

    expect(screen.getByText("halvesExist(7A:1|7A:2)")).toBeInTheDocument();
    expect(screen.queryByLabelText("halfName(1)")).toBeNull();
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).not.toHaveProperty("halfNames");
    expect(state.post.mock.calls[0]![1]).toEqual(expect.objectContaining({ halfIds: ["h-1", "h-2"] }));
  });

  it("names the first half as the locale sorts it, and sends that one first, where code units would sort otherwise", async () => {
    // "7A:2" < "7a:1" by code unit; Swedish puts 7a:1 first.
    const { user } = renderDialog({
      groups: [...classOnly, { id: "h-2", name: "7A:2", halfOfId: "g-7a" }, { id: "h-1", name: "7a:1", halfOfId: "g-7a" }],
    });

    expect(plan().map((row) => row[0])).toEqual(["7a:1", "7A:2"]);
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).toEqual(expect.objectContaining({ halfIds: ["h-1", "h-2"] }));
  });

  it("says a co-teacher who is no longer active does not follow, and sends none rather than an id no select shows", async () => {
    const { user } = renderDialog({ requirement: post({ coTeacherId: "t-gone" }) });

    expect(screen.getByText("coTeacherInactive")).toBeInTheDocument();
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        subjects: [
          { subjectId: "s-tx", teacherId: null, coTeacherId: null },
          { subjectId: "s-tm", teacherId: null, coTeacherId: null },
        ],
      }),
    );
  });

  it("starts the class's co-teacher on the first subject, says so, and sends whom each subject has", async () => {
    const { user } = renderDialog({ requirement: post({ coTeacherId: "t-cecilia" }) });

    expect(screen.getByText("coTeacherCarried(Cecilia Ås)")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^coTeacherOf\(Textilslöjd\)/ })).toHaveTextContent("Cecilia Ås");
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        subjects: [
          { subjectId: "s-tx", teacherId: null, coTeacherId: "t-cecilia" },
          { subjectId: "s-tm", teacherId: null, coTeacherId: null },
        ],
      }),
    );
  });

  it("names the halves as typed, trimmed", async () => {
    const { user } = renderDialog();

    await user.clear(screen.getByLabelText("halfName(1)"));
    await user.type(screen.getByLabelText("halfName(1)"), " 7A grupp 1 ");
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).toEqual(expect.objectContaining({ halfNames: ["7A grupp 1", "7A:2"] }));
  });

  it.each([
    ["the same subject for both halves", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("combobox", { name: "autumnSubject(7A:2)" }));
      await user.click(screen.getByRole("option", { name: "Textilslöjd" }));
    }, "subjectsSame"],
    ["a spring that starts on the year's first day", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.clear(screen.getByLabelText("springStart"));
      await user.type(screen.getByLabelText("springStart"), "2026-08-17");
    }, "springOutside"],
    ["one name for both blocks", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.clear(screen.getByLabelText("blockSpringLabel"));
      await user.type(screen.getByLabelText("blockSpringLabel"), "blockAutumn(Slöjd|7A)");
    }, "blockNamesInvalid"],
    ["an empty half name", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.clear(screen.getByLabelText("halfName(2)"));
    }, "halfNamesInvalid"],
    ["one co-teacher for both subjects", async (user: ReturnType<typeof userEvent.setup>) => {
      for (const subject of ["Textilslöjd", "Trä- och metallslöjd"]) {
        await user.click(screen.getByRole("combobox", { name: new RegExp(`^coTeacherOf\\(${subject}\\)`) }));
        await user.click(screen.getByRole("option", { name: "Cecilia Ås" }));
      }
    }, "teachersSame"],
    ["a teacher who is the subject's co-teacher too", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("combobox", { name: /^teacherOf\(Textilslöjd\)/ }));
      await user.click(screen.getByRole("option", { name: "Anna Ek" }));
      await user.click(screen.getByRole("combobox", { name: /^coTeacherOf\(Textilslöjd\)/ }));
      await user.click(screen.getByRole("option", { name: "Anna Ek" }));
    }, "coTeacherSame"],
    ["one teacher for both subjects", async (user: ReturnType<typeof userEvent.setup>) => {
      for (const subject of ["Textilslöjd", "Trä- och metallslöjd"]) {
        await user.click(screen.getByRole("combobox", { name: new RegExp(`^teacherOf\\(${subject}\\)`) }));
        await user.click(screen.getByRole("option", { name: "Anna Ek" }));
      }
    }, "teachersSame"],
  ])("will not send %s, and says why", async (_, change, problem) => {
    const { user } = renderDialog();

    await change(user);

    expect(screen.getByText(problem)).toBeInTheDocument();
    expect(submit().disabled).toBe(true);
  });

  it("says so when the school has neither slöjd subject, and waits for two to be chosen", () => {
    renderDialog({ subjects: [{ id: "s-sl", name: "Slöjd" }] });

    expect(screen.getByText("noSubjects")).toBeInTheDocument();
    expect(screen.getByText("subjectsMissing")).toBeInTheDocument();
    expect(submit().disabled).toBe(true);
  });

  it("says a class with one half left cannot be split, and will not send", () => {
    renderDialog({ groups: [...classOnly, { id: "h-1", name: "7A:1", halfOfId: "g-7a" }] });

    expect(screen.getByText("oneHalf(7A|7A:1)")).toBeInTheDocument();
    expect(submit().disabled).toBe(true);
  });

  it("keeps the dialog open with the staffing policy's refusal in it", async () => {
    state.post.mockRejectedValue(
      new ApiError(409, "Trä- och metallslöjd för 7A:2: …", "STAFF_TEACHER_NOT_QUALIFIED", { subjectName: "Trä- och metallslöjd" }),
    );
    const { user, onClose } = renderDialog();

    await user.click(submit());

    expect(await screen.findByText(/STAFF_TEACHER_NOT_QUALIFIED/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with anything else the gateway refuses, in its words", async () => {
    state.post.mockRejectedValue(new ApiError(409, "7A:2 har redan en post i Textilslöjd.", "HALF_HAS_SUBJECT"));
    const { user, onClose } = renderDialog();

    await user.click(submit());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("failedTitle");
    expect(alert).toHaveTextContent("7A:2 har redan en post i Textilslöjd.");
    expect(onClose).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });

  it("names the post each warning is about", async () => {
    state.post.mockResolvedValue({
      halves: [
        { id: "h-1", name: "7A:1" },
        { id: "h-2", name: "7A:2" },
      ],
      requirements: [{ id: "n-2", studentGroupId: "h-2", subjectId: "s-tm" }],
      warnings: [{ code: "STAFF_TEACHER_NOT_QUALIFIED", params: {}, requirementId: "n-2" }],
    });
    const { user, onClose } = renderDialog();

    await user.click(submit());

    expect(state.warning).toHaveBeenCalledWith("done(7A · Slöjd|7A:1|7A:2)", {
      description: expect.stringMatching(/^Trä- och metallslöjd · 7A:2: STAFF_TEACHER_NOT_QUALIFIED/),
      duration: 12_000,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
