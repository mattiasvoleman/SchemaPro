import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SchoolUnit } from "@/lib/school-units";
import type { LocalTimplanCheckResponse, LocalTimplanDetail } from "@/lib/timplan-queries";
import type { Profile, Subject } from "@/lib/types";
import { ProfileProvider } from "@/components/profile-context";
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
  gradeFrom: null,
  gradeTo: null,
  gradeSpanSetAt: null,
  gradeSpanSetByUserId: null,
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

/** The same document for a plan with the span 4–9: the lågstadium is not the plan's. */
const SPAN_CHECK = (planId: string): LocalTimplanCheckResponse => ({
  ...SAVED_CHECK(planId),
  gradeSpan: { gradeFrom: 4, gradeTo: 9, partial: true },
  gradesOutsideStages: [1, 2, 3],
});

const ADMIN = { role: "SCHOOL_ADMIN" } as Profile;
const TEACHER = { role: "TEACHER" } as Profile;

const unit = (gradeFrom: number, gradeTo: number): SchoolUnit => ({
  id: `u-${gradeFrom}-${gradeTo}`,
  name: `Enhet ${gradeFrom}–${gradeTo}`,
  code: null,
  schoolTypes: ["GR"],
  gradeFrom,
  gradeTo,
  fromSource: false,
});

const mutation = () => ({ mutateAsync: vi.fn(async (..._args: unknown[]) => ({}) as never), isPending: false });

const state = vi.hoisted(() => ({
  plans: [] as unknown[],
  subjects: null as unknown[] | null,
  plan: null as unknown,
  check: null as unknown,
  actions: null as unknown as Record<string, { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }>,
  download: vi.fn(),
  groups: [] as unknown[],
  units: undefined as SchoolUnit[] | undefined,
  /** What the page told useSchoolUnitsForSpan: whether the caller may read the skolenheter. */
  unitsAsked: [] as boolean[],
}));

const YEARS = [
  { id: "y-0", name: "2025/26", startDate: "2025-08-18", endDate: "2026-06-12", isActive: false, predecessorId: null },
  { id: "y-1", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11", isActive: true, predecessorId: "y-0" },
  { id: "y-2", name: "2027/28", startDate: "2027-08-16", endDate: "2028-06-09", isActive: false, predecessorId: "y-1" },
];

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: YEARS }),
  useRequirements: () => ({ data: [] }),
  useGroups: () => ({ data: state.groups, isLoading: false, isError: false }),
  useNationalTimplans: () => ({ data: NATIONAL, isLoading: false, isError: false }),
  useSubjects: () => ({ data: state.subjects ?? SUBJECTS, isLoading: false, isError: false }),
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
  useSchoolUnitsForSpan: (enabled: boolean) => {
    state.unitsAsked.push(enabled);
    return { data: enabled ? state.units : undefined };
  },
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

// The export module, which lib/csv re-exports: the page imports downloadCsv
// from it directly, and the import dialog's template link reaches the same
// function through lib/csv.
vi.mock("@/lib/csv-export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/csv-export")>()),
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

/** The page as a signed-in profile has it: the admin the /admin layout lets in, unless told otherwise. */
const renderPage = (profile: Profile = ADMIN) =>
  render(
    <ProfileProvider profile={profile} school={null}>
      <TimplanPage />
    </ProfileProvider>,
  );

beforeEach(() => {
  state.groups = [];
  state.units = undefined;
  state.unitsAsked = [];
  state.actions = {
    create: mutation(),
    update: mutation(),
    setSpan: mutation(),
    replaceEntries: mutation(),
    decide: mutation(),
    reopen: mutation(),
    copy: mutation(),
    remove: mutation(),
    generate: mutation(),
  };
  state.download.mockReset();
  state.subjects = null;
  show(planOf());
});

describe("TimplanPage: the saved check, or the live one while editing", () => {
  it("paints the gateway's check while the grid is clean, and its own the moment a cell changes", async () => {
    const user = userEvent.setup();
    renderPage();
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
    renderPage();
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
    renderPage();
    await user.type(input("s-bl", 4), "50");
    await user.click(screen.getByRole("button", { name: "save" }));

    const [[body]] = state.actions.replaceEntries.mutateAsync.mock.calls as [[{ entries: { subjectId: string }[] }]];
    expect(body.entries.map((entry) => entry.subjectId)).not.toContain("s-deleted");
    expect(body.entries).toHaveLength(4);
  });

  it("a changed week count goes to PATCH as a number, read from a decimal comma", async () => {
    const user = userEvent.setup();
    renderPage();
    const weeks = screen.getByLabelText("weeksLabel");
    await user.clear(weeks);
    await user.type(weeks, "36,0");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(state.actions.update.mutateAsync).toHaveBeenCalledWith({ id: "p-draft", planningWeeks: 36 });
    expect(state.actions.replaceEntries.mutateAsync).not.toHaveBeenCalled();
  });

  it("will not save a cell that is not whole minutes, and says how many there are", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(input("s-bl", 4), "4,5");
    expect(screen.getByRole("alert")).toHaveTextContent("invalidCells(1)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });
});

describe("TimplanPage: a warning lights its cells", () => {
  it("clicking a verdict in the rail highlights the grid cells it is about — even a cell nobody planned yet", async () => {
    const user = userEvent.setup();
    show(planOf(), null); // no saved check: the page shows its own
    renderPage();
    await user.click(screen.getByRole("button", { name: /TIMPLAN_PROTECTED_SUBJECT_REDUCED\(.*Matematik.*stagesInline.MELLAN/ }));
    expect(input("s-ma", 4)).toHaveAttribute("data-highlighted", "true");
    expect(input("s-ma", 1)).not.toHaveAttribute("data-highlighted");
  });
});

describe("TimplanPage: deciding and a decided plan", () => {
  it("decides through the dialog, with the note the admin wrote", async () => {
    const user = userEvent.setup();
    renderPage();
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
    renderPage();
    await user.type(input("s-bl", 4), "50");
    expect(screen.getByRole("button", { name: "decide" })).toBeDisabled();
  });

  it("shows a decided plan read-only, with who decided and the note, and offers Öppna igen instead of Spara", () => {
    show(DECIDED);
    renderPage();
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
    renderPage();
    await user.click(screen.getByRole("button", { name: "reopen" }));
    await user.click(await screen.findByRole("button", { name: "reopenConfirm" }));
    expect(state.actions.reopen.mutateAsync).toHaveBeenCalledWith({ id: "p-decided", name: undefined });
  });

  it("asks before deleting a decided plan, and names it a decided plan", async () => {
    const user = userEvent.setup();
    show(DECIDED);
    renderPage();
    await user.click(screen.getByRole("button", { name: "delete" }));
    expect(await screen.findByText("deleteTitleDecided(Beslutad 2025)")).toBeInTheDocument();
    expect(screen.getByText("deleteBodyDecided")).toBeInTheDocument();
    expect(state.actions.remove.mutateAsync).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "deleteConfirmDecided" }));
    expect(state.actions.remove.mutateAsync).toHaveBeenCalledWith("p-decided");
  });

  it("asks before deleting a draft too, as a draft", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "delete" }));
    expect(await screen.findByText("deleteTitleDraft(Grundskola 2026)")).toBeInTheDocument();
    expect(screen.queryByText("deleteBodyDecided")).not.toBeInTheDocument();
  });
});

describe("TimplanPage: files and the 2028 lydelse", () => {
  it("exports the saved plan in the format its import reads", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /exportCsv/ }));
    const [filename, content] = state.download.mock.calls[0]! as [string, string];
    expect(filename).toBe("lokal_timplan.csv");
    expect(content).toContain("amne;arskurs;minuter_per_vecka;notering");
    expect(content).toContain("MA;1;236;");
  });

  it("opens the import for the plan on screen", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /importCsv/ }));
    expect(await screen.findByText("importInto(Grundskola 2026)")).toBeInTheDocument();
  });

  it("says 'fördelning ej publicerad' for a plan against the 2028 law, not zero hours in every cell", async () => {
    show(planOf({ nationalTimplanVersionId: LAW_2028.id }), null);
    renderPage();
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
    renderPage();
    expect(screen.getByText("noPlansTitle")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "newPlan" }).length).toBeGreaterThan(0);
  });
});

describe("TimplanPage: the läsår side (P2)", () => {
  it("opens Skapa timplansposter for the plan on screen, and not while cells are unsaved", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: /generateButton/ }));
    expect(await screen.findByText("body(Grundskola 2026)")).toBeInTheDocument();
  });

  it("keeps Skapa timplansposter shut while the grid has unsaved cells", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.clear(input("s-ma", 3));
    await user.type(input("s-ma", 3), "200");
    expect(screen.getByRole("button", { name: /generateButton/ })).toBeDisabled();
  });

  it("opens Timplan per årskurs and links to Täckning", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByRole("link", { name: /coverageLink/ })).toHaveAttribute("href", "/admin/timplan/tackning");
    await user.click(screen.getByRole("button", { name: /yearTimplansButton/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "title" })).toBeInTheDocument();
  });
});

describe("TimplanPage: subjects without a national code", () => {
  it("says how many counted subjects lack a code and links to Ämnen, unplanned ones included", () => {
    // Production 2026-10-07: 23 subjects, none coded, an empty plan — 72
    // "under mål" rows and nothing saying why. TIMPLAN_SUBJECT_UNMAPPED fires
    // only for an uncoded subject WITH minutes, so the page counts itself.
    state.subjects = [
      subject("s-bl", "Bild", null),
      subject("s-ma", "Matematik", null),
      { ...subject("s-mt", "Mentorstid", null), countsTowardTimplan: false },
    ];
    show(planOf({ entries: [] }));
    renderPage();

    expect(screen.getByText(/^uncodedNotice\(2\)/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "uncodedNoticeLink" })).toHaveAttribute("href", "/admin/subjects");
  });

  it("says nothing when every counted subject has a code", () => {
    renderPage();
    expect(screen.queryByText(/uncodedNotice/)).not.toBeInTheDocument();
  });
});

describe("TimplanPage: Timplaner per årskull", () => {
  it("names, per cohort of this year's and next year's classes, the lydelse each stadium is judged against", async () => {
    state.groups = [
      { id: "g-7a", academicYearId: "y-1", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-1a", academicYearId: "y-2", name: "1A", kind: "CLASS", gradeLevel: 1 },
      { id: "g-ma", academicYearId: "y-1", name: "Ma-grupp", kind: "TEACHING_GROUP", gradeLevel: 7 },
      { id: "g-9a", academicYearId: "y-0", name: "9A", kind: "CLASS", gradeLevel: 9 },
    ];
    const user = userEvent.setup();
    renderPage();
    // A disclosure button (no longer a native <details>): closed, it names
    // and controls the panel; opened, the panel is a region named by it.
    const toggle = await screen.findByRole("button", { name: "title" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "title" })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const notice = screen.getByRole("region", { name: "title" });
    expect(toggle).toHaveAttribute("aria-controls", notice.id);
    const rows = within(notice).getAllByRole("listitem").map((item) => item.textContent);
    // 7A began åk 1 in 2020: lågstadiet finished June 2023, before SFS 2023:945
    // (no lydelse in the reference data); mellanstadiet reads bilaga 1; its
    // högstadium reaches 2028/29, read against bilaga 1 as an assumption.
    expect(rows[0]).toContain("cohort(PRE_2028|2020) · 7A");
    expect(rows[0]).toContain("stageVersion(LAG||missing)");
    expect(rows[0]).toContain("stageVersion(MELLAN|SFS 2023:945 B1|published)");
    expect(rows[0]).toContain("stageVersion(HOG|SFS 2023:945 B1|assumed)");
    // Next year's 1A, and the first cohort of the tioårig grundskola, which
    // has a total and no published distribution.
    expect(rows[1]).toContain("cohort(PRE_2028|2027) · 1A");
    expect(rows[2]).toContain("cohort(REFORMED_2028|2028) · noClasses");
    expect(rows[2]).toContain("stageVersion(LAG|SFS 2025:729|unpublished)");
    // A teaching group and a finished year's class are no cohort here.
    expect(notice).not.toHaveTextContent(/Ma-grupp|9A/);
    expect(notice).toHaveTextContent("sources");
  });

  it("keeps the notice on screen while a dialog's chunk loads: the two do not share a Suspense boundary", async () => {
    const user = userEvent.setup();
    renderPage();
    // The disclosure button is what shows of the closed notice.
    const notice = await screen.findByRole("button", { name: "title" });
    expect(notice).toBeVisible();
    // Timplan per årskurs is lazy: its first open suspends until the chunk is in.
    await user.click(screen.getByRole("button", { name: /yearTimplansButton/ }));
    expect(notice).toBeVisible();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(notice).toBeVisible();
  });
});

describe("TimplanPage under Läsbehörighet", () => {
  // The (app) layout's readOnlyStyle hides [data-writes~="PLANERING"] and
  // takes the pointer from [data-writes-inert~="PLANERING"] for a profile that
  // does not write planering: local-timplans.controller.ts @Area('PLANERING'),
  // Besluta included, and the import's /import/timplan.
  it("hides every act on a draft but the export, and leaves the plan's fields and cells to read", () => {
    renderPage();
    for (const name of ["newPlan", "save", "decide", "copy", "generateButton", "importCsv", "delete"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}$`) })).toHaveAttribute("data-writes", "PLANERING");
    }
    expect(screen.getByRole("button", { name: "exportCsv" })).not.toHaveAttribute("data-writes");
    expect(screen.getByRole("button", { name: "yearTimplansButton" })).not.toHaveAttribute("data-writes");
    expect(screen.getByRole("combobox", { name: "planLabel" })).not.toHaveAttribute("data-writes-inert");
    // The fields are a writer's to type in: read-only only for a reader, below.
    expect(screen.getByLabelText("nameLabel")).not.toHaveAttribute("readonly");
    expect(input("s-ma", 1)).not.toHaveAttribute("readonly");
  });

  it("gives a reader the plan's fields and cells read-only, by keyboard as by pointer", () => {
    render(
      <ProfileProvider profile={ADMIN} school={null} readOnly>
        <TimplanPage />
      </ProfileProvider>,
    );
    expect(screen.getByLabelText("nameLabel")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("weeksLabel")).toHaveAttribute("readonly");
    expect(screen.getByRole("combobox", { name: "versionLabel" })).toBeDisabled();
    expect(input("s-ma", 1)).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "weeksUseSuggestion" })).toBeNull();
  });

  it("hides Öppna igen on a decided plan, and the empty state's Ny timplan", () => {
    show(DECIDED);
    const { unmount } = renderPage();
    expect(screen.getByRole("button", { name: "reopen" })).toHaveAttribute("data-writes", "PLANERING");
    unmount();
    state.plans = [];
    state.plan = null;
    renderPage();
    for (const add of screen.getAllByRole("button", { name: "newPlan" })) {
      expect(add).toHaveAttribute("data-writes", "PLANERING");
    }
  });
});

describe("TimplanPage: the plan's årskurs span", () => {
  const SPAN_PLAN = (overrides: Partial<LocalTimplanDetail> = {}) =>
    planOf({ gradeFrom: 4, gradeTo: 9, entries: [], ...overrides });
  /** The decided plan, with a span (or with the given overrides of it). */
  const DECIDED_SPAN = (overrides: Partial<LocalTimplanDetail> = {}) =>
    SPAN_PLAN({ ...DECIDED, gradeFrom: 4, gradeTo: 9, entries: [], ...overrides });
  const showSpan = () => show(SPAN_PLAN(), SPAN_CHECK("p-draft"));
  const headers = () => screen.getAllByRole("columnheader").map((cell) => cell.textContent);

  describe("in the grid and the check", () => {
    it("draws the årskurser outside the span grey, without a sum, and says the minutes there are not counted", () => {
      showSpan();
      renderPage();
      expect(headers()).not.toContain("stageSumColumn(stagesShort.LAG)");
      expect(headers()).toContain("stageSumColumn(stagesShort.MELLAN)");
      const greyHeader = screen.getByText("gradeColumn(2)").closest("th")!;
      expect(greyHeader).toHaveClass("bg-muted/40");
      expect(greyHeader).toHaveAttribute("title", "outsideStagesHint");
      expect(screen.getByText("outsideStagesHint")).toBeInTheDocument();
      // As editable as förskoleklassen's: the minutes are stored.
      expect(input("s-ma", 2)).not.toHaveAttribute("readonly");
    });

    it("repaints with the span before the round trip: the live check is the plan's, not the whole form's", async () => {
      const user = userEvent.setup();
      // No saved check yet: the page computes its own, with the plan's span.
      show(SPAN_PLAN(), null);
      renderPage();
      await user.type(input("s-ma", 4), "50");
      expect(screen.getByText("warningsLive")).toBeInTheDocument();
      // Not the lågstadium's (the merged låg+mellan cell is the one that names it, over the årskurser held).
      expect(screen.queryAllByRole("button", { name: /stagesInline\.LAG\b/ })).toHaveLength(0);
      expect(screen.getAllByRole("button", { name: /stagesInline\.MELLAN/ }).length).toBeGreaterThan(0);
      // The guarantee is the plan's share of the form's, said to be one.
      expect(screen.getByText(/footerTotalValueEstimated\(.*\|4988\)/)).toBeInTheDocument();
    });

    it("judges the same plan against the whole lågstadium when it has no span", async () => {
      const user = userEvent.setup();
      show(planOf({ entries: [] }), null);
      renderPage();
      await user.type(input("s-ma", 4), "50");
      expect(screen.getAllByRole("button", { name: /stagesInline\.LAG\b/ }).length).toBeGreaterThan(0);
    });

    it("shows the span in the header and in the plan's own row", () => {
      showSpan();
      renderPage();
      expect(screen.getAllByText("spanRange(4|9)").length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText("spanLabel")).toBeInTheDocument();
      // The check says its pool and guarantee are estimates: so does the line.
      expect(screen.getByText(/spanHint spanEstimate/)).toBeInTheDocument();
    });

    it("says the whole school form for a plan with no span", () => {
      renderPage();
      expect(screen.getByText("spanWholeForm")).toBeInTheDocument();
      expect(screen.queryByText(/spanRange/)).not.toBeInTheDocument();
    });
  });

  describe("the notice that the plan's span is not the skolenheternas", () => {
    it("is shown to an admin, from the skolenheter and the plan's span, with the verdict left alone", () => {
      state.units = [unit(1, 9)];
      showSpan();
      renderPage();
      expect(screen.getByText("spanNoticeDiffers(spanRange(4|9)|spanRange(1|9))")).toBeInTheDocument();
      expect(screen.getByText("spanNoticeVerdict")).toBeInTheDocument();
    });

    it("is quiet when the plan's span is the skolenheternas", () => {
      state.units = [unit(4, 9)];
      showSpan();
      renderPage();
      expect(screen.queryByText(/spanNotice/)).not.toBeInTheDocument();
    });

    it("says so for a plan with no span against units that hold only part of the form", () => {
      state.units = [unit(7, 9)];
      renderPage();
      expect(screen.getByText("spanNoticeWhole(spanRange(7|9))")).toBeInTheDocument();
    });

    it("is not shown to a teacher, who never asks for the skolenheter — and the verdict is the same one", () => {
      state.units = [unit(1, 9)];
      showSpan();
      const { unmount } = renderPage();
      const asAdmin = screen.getAllByRole("button", { name: /TIMPLAN_/ }).map((button) => button.textContent);
      expect(state.unitsAsked.at(-1)).toBe(true);
      expect(screen.getByText(/spanNoticeDiffers/)).toBeInTheDocument();
      unmount();

      state.unitsAsked = [];
      renderPage(TEACHER);
      expect(state.unitsAsked.length).toBeGreaterThan(0);
      expect(state.unitsAsked.every((asked) => asked === false)).toBe(true);
      expect(screen.queryByText(/spanNotice/)).not.toBeInTheDocument();
      // The verdict depends on the plan and the statute alone.
      expect(screen.getAllByRole("button", { name: /TIMPLAN_/ }).map((button) => button.textContent)).toEqual(asAdmin);
    });

    it("offers to change the span right there, unless the plan is decided with one", async () => {
      const user = userEvent.setup();
      state.units = [unit(1, 9)];
      showSpan();
      renderPage();
      const notice = screen.getByText(/spanNoticeDiffers/).closest("[data-tone]") as HTMLElement;
      await user.click(within(notice).getByRole("button", { name: "spanChange" }));
      expect(await screen.findByText("spanDialogTitle")).toBeInTheDocument();
    });

    it("offers no change on a decided plan that has its span", () => {
      state.units = [unit(1, 9)];
      show(DECIDED_SPAN(), SPAN_CHECK("p-decided"));
      renderPage();
      const notice = screen.getByText(/spanNoticeDiffers/).closest("[data-tone]") as HTMLElement;
      expect(within(notice).queryByRole("button")).not.toBeInTheDocument();
    });
  });

  describe("changing the span of a plan", () => {
    it("lets a draft take any span, whole form included, through its own request", async () => {
      const user = userEvent.setup();
      showSpan();
      renderPage();
      await user.click(screen.getByRole("button", { name: "spanChange" }));
      await screen.findByText("spanDialogTitle");
      await user.selectOptions(screen.getByLabelText("spanFromLabel"), "spanWholeForm");
      await user.click(screen.getByRole("button", { name: "spanConfirm" }));
      expect(state.actions.setSpan.mutateAsync).toHaveBeenCalledWith({ id: "p-draft", span: null });
      expect(state.actions.update.mutateAsync).not.toHaveBeenCalled();
    });

    it("sets a span on a decided plan with none, once: says so, then records nothing else", async () => {
      const user = userEvent.setup();
      show(DECIDED);
      renderPage();
      expect(screen.getByText("spanSetOnceHint")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "spanSet" }));
      expect(await screen.findByText("spanDecidedBody(Beslutad 2025)")).toBeInTheDocument();
      expect(screen.getByText("spanDecidedOnce")).toBeInTheDocument();
      await user.selectOptions(screen.getByLabelText("spanFromLabel"), "7");
      await user.click(screen.getByRole("button", { name: "spanConfirm" }));
      expect(state.actions.setSpan.mutateAsync).toHaveBeenCalledWith({ id: "p-decided", span: { gradeFrom: 7, gradeTo: 9 } });
    });

    it("offers no edit on a decided plan that already has one, and points to Öppna igen", () => {
      show(DECIDED_SPAN(), SPAN_CHECK("p-decided"));
      renderPage();
      expect(screen.queryByRole("button", { name: "spanChange" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "spanSet" })).not.toBeInTheDocument();
      expect(screen.getByText(/^spanLockedHint/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "reopen" })).toBeInTheDocument();
    });

    it("says who set the span and when, for a span set after the decision", () => {
      show(
        DECIDED_SPAN({ gradeSpanSetAt: "2026-11-02T09:30:00.000Z", gradeSpanSetByUserId: "u-rektor" }),
        SPAN_CHECK("p-decided"),
      );
      renderPage();
      expect(screen.getByText(/^spanSetBy\(Rut Rektor\|/)).toBeInTheDocument();
    });

    it("gives the date alone when the person who set it is not among the people the page has", () => {
      show(
        DECIDED_SPAN({ gradeSpanSetAt: "2026-11-02T09:30:00.000Z", gradeSpanSetByUserId: "u-gone" }),
        SPAN_CHECK("p-decided"),
      );
      renderPage();
      expect(screen.getByText(/^spanSetOn\(/)).toBeInTheDocument();
      expect(screen.queryByText(/spanSetBy/)).not.toBeInTheDocument();
    });

    it("keeps the span button shut while cells are unsaved, as the other acts are", async () => {
      const user = userEvent.setup();
      showSpan();
      renderPage();
      await user.type(input("s-bl", 4), "50");
      expect(screen.getByRole("button", { name: "spanChange" })).toBeDisabled();
    });

    it("hides the button from a reader, as every act on a plan is", () => {
      showSpan();
      renderPage();
      expect(screen.getByRole("button", { name: "spanChange" })).toHaveAttribute("data-writes", "PLANERING");
    });
  });

  describe("a new plan, a copy and a reopened plan are given the span the skolenheter suggest", () => {
    it("prefills a new plan with them and creates it with that span", async () => {
      const user = userEvent.setup();
      state.units = [unit(7, 9)];
      renderPage();
      await user.click(screen.getAllByRole("button", { name: "newPlan" })[0]!);
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("nameLabel"), "Ny plan");
      expect((screen.getByLabelText("spanFromLabel") as HTMLSelectElement).value).toBe("7");
      await user.click(screen.getByRole("button", { name: "createConfirm" }));
      expect(state.actions.create.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ gradeFrom: 7, gradeTo: 9 }));
    });

    it("gives a teacher's page nothing to prefill from: the new plan is for the whole form", async () => {
      const user = userEvent.setup();
      state.units = [unit(7, 9)];
      renderPage(TEACHER);
      await user.click(screen.getAllByRole("button", { name: "newPlan" })[0]!);
      const dialog = await screen.findByRole("dialog");
      await user.type(within(dialog).getByLabelText("nameLabel"), "Ny plan");
      expect((screen.getByLabelText("spanFromLabel") as HTMLSelectElement).value).toBe("");
      await user.click(screen.getByRole("button", { name: "createConfirm" }));
      expect(state.actions.create.mutateAsync.mock.calls[0]![0]).not.toHaveProperty("gradeFrom");
    });

    it("copies a plan with a span by sending no span, so the gateway copies it", async () => {
      const user = userEvent.setup();
      state.units = [unit(7, 9)];
      showSpan();
      renderPage();
      await user.click(screen.getByRole("button", { name: "copy" }));
      const select = await screen.findByLabelText("spanFromLabel");
      expect((select as HTMLSelectElement).value).toBe("4");
      await user.click(screen.getByRole("button", { name: "copyConfirm" }));
      expect(state.actions.copy.mutateAsync).toHaveBeenCalledWith({ id: "p-draft", name: undefined });
      expect(state.actions.copy.mutateAsync.mock.calls[0]![0]).not.toHaveProperty("gradeFrom");
    });

    it("reopens a decided plan that has no span as a draft with the skolenheternas, which is where it gets one", async () => {
      const user = userEvent.setup();
      state.units = [unit(7, 9)];
      show(DECIDED);
      state.actions.reopen.mutateAsync.mockResolvedValue(planOf({ id: "p-new" }));
      renderPage();
      await user.click(screen.getByRole("button", { name: "reopen" }));
      expect((await screen.findByLabelText("spanFromLabel") as HTMLSelectElement).value).toBe("7");
      await user.click(screen.getByRole("button", { name: "reopenConfirm" }));
      expect(state.actions.reopen.mutateAsync).toHaveBeenCalledWith({
        id: "p-decided",
        name: undefined,
        gradeFrom: 7,
        gradeTo: 9,
      });
    });

    it("lets the admin reopen for the whole form, stating no span at all", async () => {
      const user = userEvent.setup();
      state.units = [unit(7, 9)];
      show(DECIDED);
      state.actions.reopen.mutateAsync.mockResolvedValue(planOf({ id: "p-new" }));
      renderPage();
      await user.click(screen.getByRole("button", { name: "reopen" }));
      await user.selectOptions(await screen.findByLabelText("spanFromLabel"), "spanWholeForm");
      await user.click(screen.getByRole("button", { name: "reopenConfirm" }));
      expect(state.actions.reopen.mutateAsync).toHaveBeenCalledWith({ id: "p-decided", name: undefined });
    });
  });

  describe("a lydelse that numbers the årskurser the other way", () => {
    it("cannot be chosen under a span, which the gateway would refuse; the field says why", async () => {
      const user = userEvent.setup();
      showSpan();
      renderPage();
      expect(screen.getByText("spanVersionLocked")).toBeInTheDocument();
      await user.click(screen.getByRole("combobox", { name: "versionLabel" }));
      const option = await screen.findByRole("option", { name: new RegExp(LAW_2028.sfs) });
      expect(option).toHaveAttribute("aria-disabled", "true");
    });

    it("can be chosen by a plan with no span", async () => {
      const user = userEvent.setup();
      renderPage();
      expect(screen.queryByText("spanVersionLocked")).not.toBeInTheDocument();
      await user.click(screen.getByRole("combobox", { name: "versionLabel" }));
      const option = await screen.findByRole("option", { name: new RegExp(LAW_2028.sfs) });
      expect(option).not.toHaveAttribute("aria-disabled", "true");
    });
  });
});
