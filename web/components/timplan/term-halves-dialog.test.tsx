import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { TeacherQualificationKind, TeachingRequirement } from "@/lib/types";
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
  get: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post: state.post, get: state.get },
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
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
  { id: "s-sl", name: "Slöjd", nationalCode: "SL" },
  { id: "s-tm", name: "Trä- och metallslöjd", nationalCode: "SL" },
  { id: "s-tx", name: "Textilslöjd", nationalCode: "SL" },
  { id: "s-ma", name: "Matematik", nationalCode: "MA" },
];
const teachers = [
  { id: "t-anna", firstName: "Anna", lastName: "Ek" },
  { id: "t-bo", firstName: "Bo", lastName: "Al" },
  { id: "t-cecilia", firstName: "Cecilia", lastName: "Ås" },
];
const classOnly = [{ id: "g-7a", name: "7A", halfOfId: null }];
/** 7A is åk 7: the span the behörighet is judged for. */
const SPANS = new Map([["g-7a", { min: 7, max: 7 }]]);
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
        gradeSpans={SPANS}
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
  // The year attaches no plan unless a test says so.
  state.get.mockReset().mockResolvedValue([]);
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
    // What is carried over is said: both percentages; the lessons below.
    expect(screen.getByText("description(7A · Slöjd|100|100)")).toBeInTheDocument();
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
    // Both subjects carry slöjd's code: nothing to say about it.
    expect(screen.queryByText("codeTitle")).toBeNull();
    expect(screen.getByText("generatorNote")).toBeInTheDocument();
    expect(submit().disabled).toBe(false);
  });

  it("sends the subjects with their teachers, the spring's first day, the halves' and the blocks' names, and closes", async () => {
    const { user, onClose, invalidate } = renderDialog();

    await user.click(screen.getByRole("combobox", { name: /^teacherOf\(Textilslöjd\)/ }));
    await user.click(screen.getByRole("option", { name: /^Anna Ek/ }));
    await user.click(submit());

    expect(state.post).toHaveBeenCalledWith("/api/v1/teaching-requirements/r-sl/term-halves", {
      subjects: [
        { subjectId: "s-tx", teacherId: "t-anna", coTeacherId: null },
        { subjectId: "s-tm", teacherId: null, coTeacherId: null },
      ],
      springStartDate: "2027-01-04",
      halfNames: ["7A:1", "7A:2"],
      blockNames: ["blockName(Slöjd|7A|blockSuffix.autumn)", "blockName(Slöjd|7A|blockSuffix.spring)"],
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

  it("preselects the class's co-teacher once the teacher list arrives after the dialog opened", async () => {
    const client = new QueryClient();
    const props = {
      requirement: post({ coTeacherId: "t-cecilia" }),
      groups: classOnly,
      subjects,
      gradeSpans: SPANS,
      year: YEAR,
      onClose: vi.fn(),
    };
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <TermHalvesDialog {...props} teachers={[]} />
      </QueryClientProvider>,
    );
    // Not "inactive" while the list is still on its way.
    expect(screen.queryByText("coTeacherInactive")).toBeNull();

    rerender(
      <QueryClientProvider client={client}>
        <TermHalvesDialog {...props} teachers={teachers} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("coTeacherCarried(Cecilia Ås)")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /^coTeacherOf\(Textilslöjd\)/ })).toHaveTextContent("Cecilia Ås");
    // And it is what is sent.
    await userEvent.setup().click(submit());
    expect(state.post.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ subjects: [expect.objectContaining({ coTeacherId: "t-cecilia" }), expect.objectContaining({ coTeacherId: null })] }),
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
      await user.type(screen.getByLabelText("blockSpringLabel"), "blockName(Slöjd|7A|blockSuffix.autumn)");
    }, "blockNamesInvalid"],
    ["an empty half name", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.clear(screen.getByLabelText("halfName(2)"));
    }, "halfNamesInvalid"],
    ["one co-teacher for both subjects", async (user: ReturnType<typeof userEvent.setup>) => {
      for (const subject of ["Textilslöjd", "Trä- och metallslöjd"]) {
        await user.click(screen.getByRole("combobox", { name: new RegExp(`^coTeacherOf\\(${subject}\\)`) }));
        await user.click(screen.getByRole("option", { name: /^Cecilia Ås/ }));
      }
    }, "teachersSame"],
    ["a teacher who is the subject's co-teacher too", async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole("combobox", { name: /^teacherOf\(Textilslöjd\)/ }));
      await user.click(screen.getByRole("option", { name: /^Anna Ek/ }));
      await user.click(screen.getByRole("combobox", { name: /^coTeacherOf\(Textilslöjd\)/ }));
      await user.click(screen.getByRole("option", { name: /^Anna Ek/ }));
    }, "coTeacherSame"],
    ["one teacher for both subjects", async (user: ReturnType<typeof userEvent.setup>) => {
      for (const subject of ["Textilslöjd", "Trä- och metallslöjd"]) {
        await user.click(screen.getByRole("combobox", { name: new RegExp(`^teacherOf\\(${subject}\\)`) }));
        await user.click(screen.getByRole("option", { name: /^Anna Ek/ }));
      }
    }, "teachersSame"],
  ])("will not send %s, and says why", async (_, change, problem) => {
    const { user } = renderDialog();

    await change(user);

    expect(screen.getByText(problem)).toBeInTheDocument();
    expect(submit().disabled).toBe(true);
  });

  it("names chosen subjects without the post's national code before the split, with the way to Ämnen, and splits all the same", async () => {
    const { user } = renderDialog({
      subjects: subjects.map((subject) =>
        subject.id === "s-tm" ? { ...subject, nationalCode: "TM" } : subject.id === "s-tx" ? { ...subject, nationalCode: "TX" } : subject,
      ),
    });

    // Neither has the line's code: they are read as the line's two parts,
    // at the class's pace, and both are named.
    expect(screen.getByText("codeTitle")).toBeInTheDocument();
    expect(screen.getByText("codeDiffers(Trä- och metallslöjd|Slöjd|SL)")).toBeInTheDocument();
    expect(screen.getByText("codeDiffers(Textilslöjd|Slöjd|SL)")).toBeInTheDocument();
    expect(screen.getByLabelText("lessonsCount")).toHaveValue(2);
    expect(screen.getByLabelText("lessonsMinutes")).toHaveValue(60);
    expect(screen.getByRole("link", { name: "codeAction" })).toHaveAttribute("href", "/admin/subjects");
    expect(submit().disabled).toBe(false);
    await user.click(submit());
    expect(state.post).toHaveBeenCalledTimes(1);
  });

  it("reads a subject without a code beside one of the line's as another line, keeps each pupil's hours, and sends it to Ämnen", () => {
    renderDialog({
      subjects: subjects.map((subject) => (subject.id === "s-tm" ? { ...subject, nationalCode: null } : subject)),
    });

    // A forgotten code or a subject of the school's own: the pace that keeps
    // the line's hours either way. 2 × 60 × 43 / 20 = 258 a week, 2 × 130.
    expect(screen.getByText("codeSwapMissing(Trä- och metallslöjd|Slöjd)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "codeAction" })).toHaveAttribute("href", "/admin/subjects");
    expect(screen.getByLabelText("lessonsCount")).toHaveValue(2);
    expect(screen.getByLabelText("lessonsMinutes")).toHaveValue(130);
  });

  it("names every chosen subject when the post's own subject has no national code", () => {
    renderDialog({ subjects: subjects.map((subject) => ({ ...subject, nationalCode: null })) });

    expect(screen.getByText("codeMissingOnPost(Textilslöjd|Slöjd)")).toBeInTheDocument();
    expect(screen.getByText("codeMissingOnPost(Trä- och metallslöjd|Slöjd)")).toBeInTheDocument();
  });

  it("says so when the school has neither slöjd subject, and waits for two to be chosen", () => {
    renderDialog({ subjects: [{ id: "s-sl", name: "Slöjd", nationalCode: "SL" }] });

    expect(screen.getByText("noSubjects(Slöjd)")).toBeInTheDocument();
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

/*
 * Hemkunskap in halvklass over half a term each: one subject, read by 7A:1
 * the first half of the autumn and by 7A:2 the second, at the pace that keeps
 * each pupil's hours. The autumn of YEAR is twenty teaching weeks with no lov
 * given, so its halves are ten and ten (lib/half-class-periods.test.ts).
 */
describe("one subject read in turn", () => {
  const withHemkunskap = [...subjects, { id: "s-hk", name: "Hemkunskap", nationalCode: "HKK" }];
  const hemkunskap = post({ id: "r-hk", subjectId: "s-hk", lessonsPerWeek: 1, minutesPerLesson: 30 });
  const renderHemkunskap = (props: Partial<TermHalvesDialogProps> = {}) =>
    renderDialog({ requirement: hemkunskap, subjects: withHemkunskap, ...props });
  const headers = () => within(screen.getByRole("table")).getAllByRole("columnheader").map((cell) => cell.textContent);

  it("starts as the post's own subject over the two halves of the autumn, and draws a post per half in its period", () => {
    renderHemkunskap();

    expect(screen.getByRole("combobox", { name: "periodsLabel" })).toHaveTextContent("preset.autumnHalves");
    expect(headers()).toEqual(["halfColumn", "periodSpan(1|17 augusti|25 oktober)", "periodSpan(2|26 oktober|3 januari)"]);
    expect(plan()).toEqual([
      ["7A:1", "Hemkunskap", "–"],
      ["7A:2", "–", "Hemkunskap"],
    ]);
    // One subject: its teacher and its co-teacher, nothing for a second.
    expect(screen.getAllByRole("combobox", { name: /^(teacherOf|coTeacherOf)\(/ })).toHaveLength(2);
    expect(screen.getByText("replacesOne(7A · Hemkunskap)")).toBeInTheDocument();
    expect(screen.getByText("generatorNoteOne(Hemkunskap)")).toBeInTheDocument();
    expect(submit().disabled).toBe(false);
  });

  it("proposes a pace that gives each pupil at least the class's hours, and says what the halves and the teacher get", () => {
    renderHemkunskap();

    // 1 × 30 over 43 weeks is 21,5 h; over ten weeks it takes 4,3 × 30, so
    // 5 × 30: 25 h, never 4 × 30 and 20 h.
    expect(screen.getByLabelText("lessonsCount")).toHaveValue(5);
    expect(screen.getByLabelText("lessonsMinutes")).toHaveValue(30);
    const hours = within(screen.getByTestId("term-halves-hours"));
    expect(hours.getByText("lessonsOwn(lengthPart(5|30)|lengthPart(1|30))")).toBeInTheDocument();
    expect(hours.getByText("hoursHalves(7A:1|25 h|7A:2|25 h|21,5 h)")).toBeInTheDocument();
    // The teacher has both halves: 150 a week over 20 of 43 weeks, 70 min a standard week.
    expect(hours.getByText("chargedLine(Hemkunskap|70|30)")).toBeInTheDocument();
  });

  it("sends one subject, the two periods, the halves' week and the blocks named after the periods", async () => {
    const { user } = renderHemkunskap();

    await user.click(submit());

    expect(state.post).toHaveBeenCalledWith("/api/v1/teaching-requirements/r-hk/term-halves", {
      subjects: [{ subjectId: "s-hk", teacherId: null, coTeacherId: null }],
      periods: [
        { startDate: "2026-08-17", endDate: "2026-10-25" },
        { startDate: "2026-10-26", endDate: "2027-01-03" },
      ],
      lessons: [30, 30, 30, 30, 30],
      halfNames: ["7A:1", "7A:2"],
      blockNames: ["blockName(Hemkunskap|7A|blockSuffix.autumn1)", "blockName(Hemkunskap|7A|blockSuffix.autumn2)"],
    });
  });

  it("keeps the class's pace when asked, and then sends no week of its own", async () => {
    const { user } = renderHemkunskap();

    await user.click(screen.getByRole("button", { name: "lessonsUseClass" }));
    expect(screen.getByText("lessonsClass(lengthPart(1|30))")).toBeInTheDocument();
    expect(screen.getByText("hoursHalves(7A:1|5 h|7A:2|5 h|21,5 h)")).toBeInTheDocument();
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).not.toHaveProperty("lessons");
  });

  it("sends a week the admin typed, and refuses one no post can hold", async () => {
    const { user } = renderHemkunskap();

    await user.clear(screen.getByLabelText("lessonsCount"));
    await user.type(screen.getByLabelText("lessonsCount"), "2");
    await user.clear(screen.getByLabelText("lessonsMinutes"));
    await user.type(screen.getByLabelText("lessonsMinutes"), "62");
    expect(screen.getByText("lessonsInvalid")).toBeInTheDocument();
    expect(submit().disabled).toBe(true);

    await user.clear(screen.getByLabelText("lessonsMinutes"));
    await user.type(screen.getByLabelText("lessonsMinutes"), "60");
    await user.click(submit());
    expect(state.post.mock.calls[0]![1]).toMatchObject({ lessons: [60, 60] });
  });

  it("takes half the autumn against half the spring", async () => {
    const { user } = renderHemkunskap();

    await user.click(screen.getByRole("combobox", { name: "periodsLabel" }));
    await user.click(screen.getByRole("option", { name: "preset.firstHalves" }));
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).toMatchObject({
      periods: [
        { startDate: "2026-08-17", endDate: "2026-10-25" },
        { startDate: "2027-01-04", endDate: "2027-03-21" },
      ],
      blockNames: ["blockName(Hemkunskap|7A|blockSuffix.autumn1)", "blockName(Hemkunskap|7A|blockSuffix.spring1)"],
    });
  });

  it("starts its own dates from the periods on screen, and will not send periods that meet", async () => {
    const { user } = renderHemkunskap();

    await user.click(screen.getByRole("combobox", { name: "periodsLabel" }));
    await user.click(screen.getByRole("option", { name: "preset.custom" }));
    expect(screen.getByLabelText("periodTo(1)")).toHaveValue("2026-10-25");
    expect(screen.getByLabelText("periodFrom(2)")).toHaveValue("2026-10-26");

    await user.clear(screen.getByLabelText("periodFrom(2)"));
    await user.type(screen.getByLabelText("periodFrom(2)"), "2026-10-20");
    expect(screen.getByText("periodsInvalid.OVERLAP")).toBeInTheDocument();
    expect(submit().disabled).toBe(true);

    await user.clear(screen.getByLabelText("periodFrom(2)"));
    await user.type(screen.getByLabelText("periodFrom(2)"), "2026-11-02");
    await user.click(submit());
    expect(state.post.mock.calls[0]![1]).toMatchObject({
      periods: [
        { startDate: "2026-08-17", endDate: "2026-10-25" },
        { startDate: "2026-11-02", endDate: "2027-01-03" },
      ],
      blockNames: ["blockName(Hemkunskap|7A|blockSuffix.period1)", "blockName(Hemkunskap|7A|blockSuffix.period2)"],
    });
  });

  it("keeps a block name the admin wrote, and the other still follows the periods", async () => {
    const { user } = renderHemkunskap();

    await user.clear(screen.getByLabelText("blockPeriodLabel(1)"));
    await user.type(screen.getByLabelText("blockPeriodLabel(1)"), "Hemkunskap 7A höst");
    await user.click(screen.getByRole("combobox", { name: "periodsLabel" }));
    await user.click(screen.getByRole("option", { name: "preset.springHalves" }));

    expect(screen.getByLabelText("blockPeriodLabel(1)")).toHaveValue("Hemkunskap 7A höst");
    expect(screen.getByLabelText("blockPeriodLabel(2)")).toHaveValue("blockName(Hemkunskap|7A|blockSuffix.spring2)");
  });

  it("cuts a long subject's name, never the period's, so the two blocks stay apart", () => {
    const long = "H".repeat(90);
    renderHemkunskap({ subjects: [...subjects, { id: "s-hk", name: long, nationalCode: "HKK" }] });

    const names = [1, 2].map((n) => (screen.getByLabelText(`blockPeriodLabel(${n})`) as HTMLInputElement).value);
    expect(names.map((name) => name.length)).toEqual([80, 80]);
    expect(names[0]).toMatch(/\|7A\|blockSuffix\.autumn1\)$/);
    expect(names[1]).toMatch(/\|7A\|blockSuffix\.autumn2\)$/);
    expect(screen.queryByText("blockNamesInvalid")).toBeNull();
  });

  it("swaps two subjects over the periods when the second half reads one too", async () => {
    const { user } = renderHemkunskap();

    await user.click(screen.getByRole("combobox", { name: "firstPeriodSubject(7A:2)" }));
    await user.click(screen.getByRole("option", { name: "Textilslöjd" }));

    expect(plan()).toEqual([
      ["7A:1", "Hemkunskap", "Textilslöjd"],
      ["7A:2", "Textilslöjd", "Hemkunskap"],
    ]);
    // Each pupil reads hemkunskap in one half of the autumn, and textilslöjd
    // (another code) in the other: 30 × 43 / 10 is 129 a week, 1 × 130
    // rather than 5 × 30.
    expect(screen.getByLabelText("lessonsCount")).toHaveValue(1);
    expect(screen.getByLabelText("lessonsMinutes")).toHaveValue(130);
    expect(screen.getByText("replaces(7A · Hemkunskap)")).toBeInTheDocument();
  });
});

/*
 * Hemkunskap swapped with slöjd: 6A in åk 6, its hemkunskap 1 × 30 and its
 * slöjd 2 × 40, the plan 30 and 80, and a läsår with höstlov, jullov,
 * sportlov and påsklov: 17 teaching weeks in the autumn and 20 in the spring.
 * The figures are lib/half-class-timplan.test.ts's.
 */
describe("hemkunskap swapped with slöjd", () => {
  const LOV = [
    { startDate: "2026-10-26", endDate: "2026-10-30" },
    { startDate: "2026-12-21", endDate: "2027-01-08" },
    { startDate: "2027-02-22", endDate: "2027-02-26" },
    { startDate: "2027-03-29", endDate: "2027-04-02" },
  ];
  const withHemkunskap = [
    ...subjects.filter((subject) => subject.id !== "s-sl"),
    { id: "s-sl", name: "Slöjd", nationalCode: "SLJ" },
    { id: "s-hk", name: "Hemkunskap", nationalCode: "HKK" },
  ];
  const hemkunskap = post({ id: "r-hk", subjectId: "s-hk", studentGroupId: "g-6a", lessonsPerWeek: 1, minutesPerLesson: 30 });
  const slojd = post({ id: "r-sl", subjectId: "s-sl", studentGroupId: "g-6a", lessonsPerWeek: 2, minutesPerLesson: 40 });
  const sixA = [{ id: "g-6a", name: "6A", halfOfId: null, gradeLevel: 6 }];
  const givenPlan = () =>
    state.get.mockImplementation(async (path: string) =>
      path === "/api/v1/academic-years/y1/timplans"
        ? [{ gradeLevel: 6, localTimplanId: "p-6", planName: "Lokal timplan", planStatus: "DECIDED" }]
        : {
            id: "p-6",
            name: "Lokal timplan",
            status: "DECIDED",
            entries: [
              { subjectId: "s-hk", gradeLevel: 6, minutesPerWeek: 30 },
              { subjectId: "s-sl", gradeLevel: 6, minutesPerWeek: 80 },
            ],
          },
    );
  const renderSwap = async (props: Partial<TermHalvesDialogProps> = {}) => {
    const rendered = renderDialog({
      requirement: hemkunskap,
      subjects: withHemkunskap,
      groups: sixA,
      gradeSpans: new Map([["g-6a", { min: 6, max: 6 }]]),
      closures: LOV,
      posts: [hemkunskap, slojd],
      ...props,
    });
    const { user } = rendered;
    await user.click(screen.getByRole("combobox", { name: "periodsLabel" }));
    await user.click(screen.getByRole("option", { name: "preset.terms" }));
    await user.click(screen.getByRole("combobox", { name: "autumnSubject(6A:2)" }));
    await user.click(screen.getByRole("option", { name: "Slöjd" }));
    return rendered;
  };
  /** The timplan's lines as the dialog draws them: subject, then each half. */
  const lines = () =>
    within(screen.getByTestId("term-halves-timplan"))
      .getAllByRole("row")
      .slice(1)
      .map((row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent));

  it("proposes the pace that gives each half the class's hemkunskap over the shorter term, 1 × 70", async () => {
    givenPlan();
    await renderSwap();

    expect(screen.getByLabelText("lessonsCount")).toHaveValue(1);
    expect(screen.getByLabelText("lessonsMinutes")).toHaveValue(70);
    // The hours of hemkunskap alone: 70 × 17 and 70 × 20 minutes.
    expect(screen.getByText("hoursHalvesSubject(6A:1|19,8 h|Hemkunskap|6A:2|23,3 h|18,5 h)")).toBeInTheDocument();
  });

  it("draws what a pupil of each half gets of hemkunskap and slöjd against the plan, the class's slöjd included", async () => {
    givenPlan();
    await renderSwap();

    expect(await screen.findByText("caption(6)")).toBeInTheDocument();
    expect(lines()).toEqual([
      ["Hemkunskap", "met(32|30)", "met(38|30)"],
      ["Slöjd", "met(118|80)", "met(112|80)"],
    ]);
    expect(screen.getByText("double(Slöjd|6A)")).toBeInTheDocument();
  });

  it("proposes the class's slöjd at 2 × 25, and sends it in the same save when ticked", async () => {
    givenPlan();
    const { user } = await renderSwap();

    expect(
      await screen.findByText("reduction(Slöjd|80|6A · Slöjd|lengthPart(2|40)|lengthPart(2|25)|6A:1|88|6A:2|82)"),
    ).toBeInTheDocument();
    const tick = screen.getByRole("checkbox", { name: "reductionApply(6A · Slöjd|lengthPart(2|25))" });
    expect(tick).not.toBeChecked();
    await user.click(tick);
    expect(lines()).toEqual([
      ["Hemkunskap", "met(32|30)", "met(38|30)"],
      ["Slöjd", "met(88|80)", "met(82|80)"],
    ]);
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).toMatchObject({
      subjects: [
        { subjectId: "s-hk", teacherId: null, coTeacherId: null },
        { subjectId: "s-sl", teacherId: null, coTeacherId: null },
      ],
      springStartDate: "2027-01-04",
      lessons: [70],
      adjustedPost: { requirementId: "r-sl", lessons: [25, 25] },
    });
  });

  it("takes the class's slöjd when the first half reads slöjd first", async () => {
    givenPlan();
    const { user } = renderDialog({
      requirement: hemkunskap,
      subjects: withHemkunskap,
      groups: sixA,
      gradeSpans: new Map([["g-6a", { min: 6, max: 6 }]]),
      closures: LOV,
      posts: [hemkunskap, slojd],
    });
    await user.click(screen.getByRole("combobox", { name: "periodsLabel" }));
    await user.click(screen.getByRole("option", { name: "preset.terms" }));
    await user.click(screen.getByRole("combobox", { name: "autumnSubject(6A:1)" }));
    await user.click(screen.getByRole("option", { name: "Slöjd" }));
    await user.click(screen.getByRole("combobox", { name: "autumnSubject(6A:2)" }));
    await user.click(screen.getByRole("option", { name: "Hemkunskap" }));

    // 6A:1 reads hemkunskap in the spring now: 38 and 32, the slöjd the other way.
    await user.click(await screen.findByRole("checkbox"));
    expect(lines()).toEqual([
      ["Hemkunskap", "met(38|30)", "met(32|30)"],
      ["Slöjd", "met(82|80)", "met(88|80)"],
    ]);
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).toMatchObject({
      subjects: [
        { subjectId: "s-sl", teacherId: null, coTeacherId: null },
        { subjectId: "s-hk", teacherId: null, coTeacherId: null },
      ],
      lessons: [70],
      adjustedPost: { requirementId: "r-sl", lessons: [25, 25] },
    });
  });

  it("sends no change to the class's slöjd unless it is ticked", async () => {
    givenPlan();
    const { user } = await renderSwap();
    await screen.findByText(/^reduction\(/);

    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).not.toHaveProperty("adjustedPost");
  });

  it("says the class's slöjd in a block is changed under Block, and offers no tick", async () => {
    givenPlan();
    await renderSwap({ posts: [hemkunskap, { ...slojd, blockId: "b-1" }] });

    expect(await screen.findByText("reductionInBlock(6A · Slöjd)")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("says slöjd's minutes count on its own code, and asks nothing of Ämnen", async () => {
    givenPlan();
    await renderSwap();

    expect(screen.getByText("codeSwapOwn(Slöjd|Hemkunskap|SLJ)")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "codeAction" })).toBeNull();
  });

  it("sends a slöjd without a code to Ämnen, its minutes being skolans val", async () => {
    givenPlan();
    await renderSwap({
      subjects: withHemkunskap.map((subject) => (subject.id === "s-sl" ? { ...subject, nationalCode: null } : subject)),
    });

    expect(screen.getByText("codeSwapMissing(Slöjd|Hemkunskap)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "codeAction" })).toHaveAttribute("href", "/admin/subjects");
  });

  it("says the årskurs follows no plan, and proposes no change to the slöjd", async () => {
    await renderSwap();

    expect(await screen.findByText("noPlan(6)")).toBeInTheDocument();
    expect(screen.queryByText(/^reduction\(/)).toBeNull();
  });

  it("splits the läsår in two halves of as many teaching weeks, with no spring start to ask", async () => {
    givenPlan();
    const { user } = await renderSwap();

    await user.click(screen.getByRole("combobox", { name: "periodsLabel" }));
    await user.click(screen.getByRole("option", { name: "preset.yearHalves" }));
    expect(screen.queryByLabelText("springStart")).toBeNull();
    // 18 and 19 of 37: 30 × 37 / 18 = 61,7 a week, 1 × 65.
    expect(screen.getByLabelText("lessonsMinutes")).toHaveValue(65);
    await user.click(submit());

    expect(state.post.mock.calls[0]![1]).toMatchObject({
      periods: [
        { startDate: "2026-08-17", endDate: "2027-01-17" },
        { startDate: "2027-01-18", endDate: "2027-06-11" },
      ],
      lessons: [65],
      blockNames: ["blockName(Hemkunskap|6A|blockSuffix.period1)", "blockName(Hemkunskap|6A|blockSuffix.period2)"],
    });
  });

  it("names the class's slöjd in a warning about it after the split", async () => {
    givenPlan();
    state.post.mockResolvedValue({
      halves: [
        { id: "h-1", name: "6A:1" },
        { id: "h-2", name: "6A:2" },
      ],
      requirements: [],
      adjustedRequirement: { id: "r-sl", studentGroupId: "g-6a", subjectId: "s-sl" },
      warnings: [{ code: "STAFF_TEACHER_OVER_TARGET", params: {}, requirementId: "r-sl" }],
    });
    const { user } = await renderSwap();
    await user.click(await screen.findByRole("checkbox"));

    await user.click(submit());

    expect(state.warning.mock.calls[0]![1].description).toMatch(/^6A · Slöjd: /);
  });
});

/*
 * The teachers' order, as the post's own dialog has listed them since the
 * admin asked for it there (requirements/page.test.tsx, "the order"): the
 * strongest behörighet in the picker's own subject first, the badge beside
 * each name, and the roster's order where nothing is known. The roster is
 * Anna, Bo, Cecilia; each subject below turns it over its own way.
 */
describe("the teachers' order", () => {
  const qualification = (
    userId: string,
    subjectId: string,
    kind: TeacherQualificationKind,
    extra: { minGradeLevel?: number; maxGradeLevel?: number; validTo?: string } = {},
  ) => ({ userId, subjectId, kind, minGradeLevel: 7, maxGradeLevel: 9, validFrom: null, validTo: null, ...extra });
  const QUALIFICATIONS = [
    // Textilslöjd: Cecilia legitimerad, Bo tillåten, Anna nothing.
    qualification("t-cecilia", "s-tx", "LEGITIMATION"),
    qualification("t-bo", "s-tx", "TILLATEN"),
    // Trä- och metallslöjd: Bo behörig. Anna's legitimation is for åk 1–6,
    // not 7A's åk 7, and Cecilia's ended before the läsår began.
    qualification("t-bo", "s-tm", "BEHORIG"),
    qualification("t-anna", "s-tm", "LEGITIMATION", { minGradeLevel: 1, maxGradeLevel: 6 }),
    qualification("t-cecilia", "s-tm", "LEGITIMATION", { validTo: "2026-06-30" }),
    // Matematik: Bo.
    qualification("t-bo", "s-ma", "LEGITIMATION"),
  ];
  const NAMES = ["Anna Ek", "Bo Al", "Cecilia Ås"];
  /** The open list, each teacher's option by the name it starts with. */
  const listed = () =>
    screen
      .getAllByRole("option")
      .map((option) => NAMES.find((name) => option.textContent?.startsWith(name)) ?? option.textContent);
  const optionText = (name: string) =>
    screen.getAllByRole("option").find((option) => option.textContent?.startsWith(name))?.textContent;
  /** One picker's list, read and closed again with Escape. */
  const listOf = async (user: ReturnType<typeof userEvent.setup>, picker: RegExp) => {
    await user.click(screen.getByRole("combobox", { name: picker }));
    const order = listed();
    await user.keyboard("{Escape}");
    return order;
  };

  it("lists the strongest behörighet in each subject first, in its lärare's and its medlärare's picker alike", async () => {
    const { user } = renderDialog({ qualifications: QUALIFICATIONS });

    for (const picker of [/^teacherOf\(Textilslöjd\)/, /^coTeacherOf\(Textilslöjd\)/]) {
      expect(await listOf(user, picker)).toEqual(["notAssigned", "Cecilia Ås", "Bo Al", "Anna Ek"]);
    }
    for (const picker of [/^teacherOf\(Trä- och metallslöjd\)/, /^coTeacherOf\(Trä- och metallslöjd\)/]) {
      expect(await listOf(user, picker)).toEqual(["notAssigned", "Bo Al", "Anna Ek", "Cecilia Ås"]);
    }
  });

  it("says beside each name what the post's own dialog says: the behörighet in the subject and the minutes left", async () => {
    const { user } = renderDialog({
      qualifications: QUALIFICATIONS,
      loadReport: {
        teachers: [
          { userId: "t-cecilia", balanceMinutesPerWeek: 120 },
          { userId: "t-bo", balanceMinutesPerWeek: -30 },
        ],
      },
    });
    // Once, under the four pickers, as the post's dialog says it under its own.
    expect(screen.getAllByText("candidateHint")).toHaveLength(1);

    await user.click(screen.getByRole("combobox", { name: /^teacherOf\(Textilslöjd\)/ }));
    expect(optionText("Cecilia Ås")).toBe("Cecilia ÅskindLEGITIMATIONcandidateRemaining(120)");
    expect(optionText("Bo Al")).toBe("Bo AlkindTILLATENcandidateOver(30)");
    expect(optionText("Anna Ek")).toBe("Anna EkcandidateUnqualifiedcandidateNoTarget");
    await user.keyboard("{Escape}");

    // The same teacher, another subject: another word.
    await user.click(screen.getByRole("combobox", { name: /^teacherOf\(Trä- och metallslöjd\)/ }));
    expect(optionText("Cecilia Ås")).toBe("Cecilia ÅscandidateUnqualifiedcandidateRemaining(120)");
    expect(optionText("Bo Al")).toBe("Bo AlkindBEHORIGcandidateOver(30)");
  });

  it("follows the subject when the admin chooses another one", async () => {
    const { user } = renderDialog({ qualifications: QUALIFICATIONS });

    await user.click(screen.getByRole("combobox", { name: "autumnSubject(7A:1)" }));
    await user.click(screen.getByRole("option", { name: "Matematik" }));

    expect(await listOf(user, /^teacherOf\(Matematik\)/)).toEqual(["notAssigned", "Bo Al", "Anna Ek", "Cecilia Ås"]);
  });

  it("keeps the roster's order, with no behörighet word, for a school that has recorded none", async () => {
    const { user } = renderDialog({ qualifications: [] });

    await user.click(screen.getByRole("combobox", { name: /^teacherOf\(Textilslöjd\)/ }));
    expect(listed()).toEqual(["notAssigned", "Anna Ek", "Bo Al", "Cecilia Ås"]);
    expect(optionText("Anna Ek")).toBe("Anna EkcandidateNoTarget");
  });

  it("keeps the roster's order, with no behörighet word, under a subject not chosen yet", async () => {
    const { user } = renderDialog({ qualifications: QUALIFICATIONS, subjects: subjects.filter((s) => s.id === "s-ma") });

    await user.click(screen.getByRole("combobox", { name: /^teacherOf\(subjectFallback\(1\)\)/ }));
    expect(listed()).toEqual(["notAssigned", "Anna Ek", "Bo Al", "Cecilia Ås"]);
    expect(optionText("Cecilia Ås")).toBe("Cecilia ÅscandidateNoTarget");
  });

  it("is still chosen from the keyboard: Enter, one arrow to the strongest, and a typed name wherever it stands", async () => {
    const { user } = renderDialog({ qualifications: QUALIFICATIONS });
    // Radix aria-hides the dialog while a list is open: take the trigger first.
    const lead = screen.getByRole("combobox", { name: /^teacherOf\(Textilslöjd\)/ });

    // Enter opens on Ej tilldelad; one arrow down is the strongest candidate.
    lead.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // A screen reader hears the name first, the badge after it.
    expect(screen.getByRole("option", { name: /^Cecilia Ås/ })).toHaveAccessibleName(/^Cecilia Ås.*kindLEGITIMATION/);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    // The trigger repeats the chosen line, badge words and all.
    expect(lead).toHaveTextContent("Cecilia Ås");
    expect(lead).toHaveTextContent("kindLEGITIMATION");

    // Typing a name finds it at the bottom of the list, where the order put it.
    lead.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("Anna");
    await user.keyboard("{Enter}");
    expect(lead).toHaveTextContent("Anna Ek");

    // And the request names whom it chose.
    await user.click(submit());
    expect(state.post.mock.calls[0]![1].subjects[0]).toEqual({ subjectId: "s-tx", teacherId: "t-anna", coTeacherId: null });
  });
});
