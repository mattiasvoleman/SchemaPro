import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTimplanCheckResponse, LocalTimplanDetail } from "@/lib/timplan-queries";
import type { Subject } from "@/lib/types";
import { B1, LAW_2028, NATIONAL } from "@/lib/__fixtures__/timplan-statute";
import TimplanPage from "./page";

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
 * The page over mocked reads, for what only the page decides: which check it
 * paints (the saved one while clean, its own while dirty), what Spara sends,
 * that a decided plan is read-only and reopened rather than edited, that the
 * delete confirmation names a decided plan as such, the unpublished-lydelse
 * notice, and that the rail's click reaches the grid. The grid's own
 * arithmetic and colours are covered in components/timplan/timplan-grid.test.
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
const SUBJECTS = [subject("s-bl", "Bild", "BL"), subject("s-ma", "Matematik", "MA")];

const planOf = (overrides: Partial<LocalTimplanDetail> = {}): LocalTimplanDetail => ({
  id: "p-draft",
  schoolId: "school",
  name: "Grundskola 2026",
  schoolForm: "GRUNDSKOLA",
  nationalTimplanVersionId: B1.id,
  planningWeeks: 35.6,
  status: "DRAFT",
  decidedAt: null,
  decidedByUserId: null,
  decisionNote: null,
  copiedFromId: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  entries: [
    { id: "e1", subjectId: "s-ma", gradeLevel: 1, minutesPerWeek: 236, note: null },
    { id: "e2", subjectId: "s-ma", gradeLevel: 2, minutesPerWeek: 236, note: null },
    { id: "e3", subjectId: "s-ma", gradeLevel: 3, minutesPerWeek: 236, note: null },
  ],
  ...overrides,
});

const DECIDED = planOf({
  id: "p-decided",
  name: "Beslutad 2025",
  status: "DECIDED",
  decidedAt: "2026-05-12T10:00:00.000Z",
  decidedByUserId: "u-rektor",
  decisionNote: "Beslutat av huvudman 2026-05-12, dnr 12",
});

/** A saved check whose rail is recognisably the SERVER's: one notice only. */
const SAVED_CHECK = (planId: string): LocalTimplanCheckResponse => ({
  localTimplanId: planId,
  versionCode: B1.code,
  distributionPublished: true,
  planningWeeks: 35.6,
  stageGrades: { LAG: [1, 2, 3], MELLAN: [4, 5, 6], HOG: [7, 8, 9] },
  cells: [],
  unmapped: [],
  gradesOutsideStages: [],
  skolansVal: { availableHours: 600, takenHours: 0, placedHours: 0 },
  total: { plannedHours: 6890, guaranteedHours: 6890, deficitHours: 0 },
  verdicts: [
    {
      code: "TIMPLAN_SUBJECT_UNMAPPED",
      severity: "notice",
      subjectIds: ["s-server"],
      params: { subjectId: "s-server", subjectName: "Från servern", plannedHours: 1 },
      message: "…",
    },
  ],
});

const mutation = () => ({ mutateAsync: vi.fn(async (..._args: unknown[]) => ({}) as never), isPending: false });

const state = vi.hoisted(() => ({
  plans: [] as unknown[],
  plan: null as unknown,
  check: null as unknown,
  actions: null as unknown as Record<string, { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }>,
  download: vi.fn(),
}));

const YEARS = [
  { id: "y-1", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true },
];

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: YEARS }),
  useRequirements: () => ({ data: [] }),
  useGroups: () => ({ data: [], isLoading: false, isError: false }),
  useNationalTimplans: () => ({ data: NATIONAL, isLoading: false, isError: false }),
  useSubjects: () => ({ data: SUBJECTS, isLoading: false, isError: false }),
  usePeople: () => ({
    data: [{ id: "u-rektor", firstName: "Rut", lastName: "Rektor", role: "SCHOOL_ADMIN" }],
  }),
}));

vi.mock("@/lib/timplan-queries", () => ({
  useLocalTimplans: () => ({ data: state.plans, isLoading: false, isError: false }),
  useLocalTimplan: () => ({ data: state.plan, isLoading: false, isError: false }),
  useLocalTimplanCheck: () => ({ data: state.check }),
  useLocalTimplanActions: () => state.actions,
  useImportTimplan: () => mutation(),
  useGenerateRequirements: () => state.actions.generate,
}));

vi.mock("@/lib/year-timplan-queries", () => ({
  useYearTimplans: () => ({ data: [], isLoading: false, isError: false }),
  useSaveYearTimplans: () => mutation(),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/csv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/csv")>()),
  downloadCsv: (...args: unknown[]) => state.download(...args),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const row = (subjectId: string) =>
  document.querySelector<HTMLTableRowElement>(`tr[data-subject-id="${subjectId}"]`)!;
const input = (subjectId: string, grade: number) =>
  within(row(subjectId)).getAllByRole("textbox")[grade]! as HTMLInputElement;

function show(plan: LocalTimplanDetail, check: LocalTimplanCheckResponse | null = SAVED_CHECK(plan.id)) {
  state.plans = [{ ...plan, entryCount: plan.entries.length }];
  state.plan = plan;
  state.check = check;
}

beforeEach(() => {
  state.actions = {
    create: mutation(),
    update: mutation(),
    replaceEntries: mutation(),
    decide: mutation(),
    reopen: mutation(),
    copy: mutation(),
    remove: mutation(),
    generate: mutation(),
  };
  state.download.mockReset();
  show(planOf());
});

describe("TimplanPage: the saved check, or the live one while editing", () => {
  it("paints the gateway's check while the grid is clean, and its own the moment a cell changes", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    // Clean: the rail is the server's document.
    expect(screen.getByRole("button", { name: /Från servern/ })).toBeInTheDocument();
    expect(screen.queryByText("warningsLive")).not.toBeInTheDocument();

    await user.clear(input("s-ma", 3));
    await user.type(input("s-ma", 3), "200");
    // Dirty: computed in the browser from what was typed, and said to be.
    expect(screen.queryByRole("button", { name: /Från servern/ })).not.toBeInTheDocument();
    expect(screen.getByText("warningsLive")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /TIMPLAN_PROTECTED_SUBJECT_REDUCED/ }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("unsaved")).toBeInTheDocument();
  });

  it("Spara sends the whole grid to PUT /entries and nothing to PATCH when only cells changed", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.type(input("s-bl", 4), "50");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(state.actions.update.mutateAsync).not.toHaveBeenCalled();
    expect(state.actions.replaceEntries.mutateAsync).toHaveBeenCalledWith({
      id: "p-draft",
      entries: [
        { subjectId: "s-ma", gradeLevel: 1, minutesPerWeek: 236 },
        { subjectId: "s-ma", gradeLevel: 2, minutesPerWeek: 236 },
        { subjectId: "s-ma", gradeLevel: 3, minutesPerWeek: 236 },
        { subjectId: "s-bl", gradeLevel: 4, minutesPerWeek: 50 },
      ],
    });
  });

  it("leaves out a cell whose subject is gone — deleted or not this school's — instead of sending it", async () => {
    // A subject deleted on Ämnen cascades its draft entries on the server,
    // but a plan cached within staleTime still holds them; sending the cell
    // got a 400 naming an id the grid cannot show or clear.
    const plan = planOf();
    show({
      ...plan,
      entries: [...plan.entries, { id: "e-ghost", subjectId: "s-deleted", gradeLevel: 4, minutesPerWeek: 60, note: null }],
    });
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.type(input("s-bl", 4), "50");
    await user.click(screen.getByRole("button", { name: "save" }));

    const [[body]] = state.actions.replaceEntries.mutateAsync.mock.calls as [[{ entries: { subjectId: string }[] }]];
    expect(body.entries.map((entry) => entry.subjectId)).not.toContain("s-deleted");
    expect(body.entries).toHaveLength(4);
  });

  it("a changed week count goes to PATCH as a number, read from a decimal comma", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    const weeks = screen.getByLabelText("weeksLabel");
    await user.clear(weeks);
    await user.type(weeks, "36,0");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(state.actions.update.mutateAsync).toHaveBeenCalledWith({ id: "p-draft", planningWeeks: 36 });
    expect(state.actions.replaceEntries.mutateAsync).not.toHaveBeenCalled();
  });

  it("will not save a cell that is not whole minutes, and says how many there are", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.type(input("s-bl", 4), "4,5");
    expect(screen.getByRole("alert")).toHaveTextContent("invalidCells(1)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });
});

describe("TimplanPage: a warning lights its cells", () => {
  it("clicking a verdict in the rail highlights the grid cells it is about — even a cell nobody planned yet", async () => {
    const user = userEvent.setup();
    show(planOf(), null); // no saved check: the page shows its own
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: /TIMPLAN_PROTECTED_SUBJECT_REDUCED\(.*Matematik.*stagesInline.MELLAN/ }));
    expect(input("s-ma", 4)).toHaveAttribute("data-highlighted", "true");
    expect(input("s-ma", 1)).not.toHaveAttribute("data-highlighted");
  });
});

describe("TimplanPage: deciding and a decided plan", () => {
  it("decides through the dialog, with the note the admin wrote", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: "decide" }));
    const note = await screen.findByLabelText("decisionNoteLabel");
    await user.type(note, "Beslutat av huvudman 2026-05-12");
    await user.click(screen.getByRole("button", { name: "decideConfirm" }));
    expect(state.actions.decide.mutateAsync).toHaveBeenCalledWith({
      id: "p-draft",
      decisionNote: "Beslutat av huvudman 2026-05-12",
    });
  });

  it("Besluta waits for unsaved cells to be saved", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.type(input("s-bl", 4), "50");
    expect(screen.getByRole("button", { name: "decide" })).toBeDisabled();
  });

  it("shows a decided plan read-only, with who decided and the note, and offers Öppna igen instead of Spara", () => {
    show(DECIDED);
    render(<TimplanPage />);
    expect(input("s-ma", 1)).toHaveAttribute("readonly");
    expect(screen.getByLabelText("nameLabel")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "save" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "decide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /importCsv/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reopen" })).toBeInTheDocument();
    expect(screen.getByText(/decidedBy\(Rut Rektor\)/)).toBeInTheDocument();
    expect(screen.getByText("decidedNote(Beslutat av huvudman 2026-05-12, dnr 12)")).toBeInTheDocument();
  });

  it("reopens a decided plan into a new draft and shows the draft", async () => {
    const user = userEvent.setup();
    show(DECIDED);
    state.actions.reopen.mutateAsync.mockResolvedValue(planOf({ id: "p-new", name: "Beslutad 2025 (utkast)" }));
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: "reopen" }));
    await user.click(await screen.findByRole("button", { name: "reopenConfirm" }));
    expect(state.actions.reopen.mutateAsync).toHaveBeenCalledWith({ id: "p-decided", name: undefined });
  });

  it("asks before deleting a decided plan, and names it a decided plan", async () => {
    const user = userEvent.setup();
    show(DECIDED);
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: "delete" }));
    expect(await screen.findByText("deleteTitleDecided(Beslutad 2025)")).toBeInTheDocument();
    expect(screen.getByText("deleteBodyDecided")).toBeInTheDocument();
    expect(state.actions.remove.mutateAsync).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "deleteConfirmDecided" }));
    expect(state.actions.remove.mutateAsync).toHaveBeenCalledWith("p-decided");
  });

  it("asks before deleting a draft too, as a draft", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: "delete" }));
    expect(await screen.findByText("deleteTitleDraft(Grundskola 2026)")).toBeInTheDocument();
    expect(screen.queryByText("deleteBodyDecided")).not.toBeInTheDocument();
  });
});

describe("TimplanPage: files and the 2028 lydelse", () => {
  it("exports the saved plan in the format its import reads", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: /exportCsv/ }));
    const [filename, content] = state.download.mock.calls[0]! as [string, string];
    expect(filename).toBe("lokal_timplan.csv");
    expect(content).toContain("amne;arskurs;minuter_per_vecka;notering");
    expect(content).toContain("MA;1;236;");
  });

  it("opens the import for the plan on screen", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: /importCsv/ }));
    expect(await screen.findByText("importInto(Grundskola 2026)")).toBeInTheDocument();
  });

  it("says 'fördelning ej publicerad' for a plan against the 2028 law, not zero hours in every cell", async () => {
    show(planOf({ nationalTimplanVersionId: LAW_2028.id }), null);
    render(<TimplanPage />);
    expect(screen.getByText("unpublishedTitle")).toBeInTheDocument();
    expect(screen.getByText(`unpublishedBody(${LAW_2028.code}|7424)`)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED/ }),
      ).toBeInTheDocument(),
    );
    // No stage sum is coloured: there is nothing national to hold it to.
    expect(document.querySelectorAll('td[data-stage][data-tone="under"]')).toHaveLength(0);
    expect(document.querySelectorAll('td[data-stage][data-tone="met"]')).toHaveLength(0);
  });

  it("starts from an empty state that offers to create the first plan", () => {
    state.plans = [];
    state.plan = null;
    render(<TimplanPage />);
    expect(screen.getByText("noPlansTitle")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "newPlan" }).length).toBeGreaterThan(0);
  });
});

describe("TimplanPage: the läsår side (P2)", () => {
  it("opens Skapa timplansposter for the plan on screen, and not while cells are unsaved", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: /generateButton/ }));
    expect(await screen.findByText("body(Grundskola 2026)")).toBeInTheDocument();
  });

  it("keeps Skapa timplansposter shut while the grid has unsaved cells", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.clear(input("s-ma", 3));
    await user.type(input("s-ma", 3), "200");
    expect(screen.getByRole("button", { name: /generateButton/ })).toBeDisabled();
  });

  it("opens Timplan per årskurs", async () => {
    const user = userEvent.setup();
    render(<TimplanPage />);
    await user.click(screen.getByRole("button", { name: /yearTimplansButton/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument();
  });
});
