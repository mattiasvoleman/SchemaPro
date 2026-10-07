import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { RolloverOptions, RolloverPreview, StudentGroup } from "@/lib/types";
import { RolloverWizard } from "./rollover-wizard";

/**
 * The wizard over the real hooks and the real Swedish messages, with the
 * gateway mocked at lib/api. What only the wizard decides: what it previews
 * (the request body), what the mirror shows before the preview answers (next
 * year's names, collisions, the intake twin), that no lov is carried unless
 * ticked, and what "Skapa" sends — the confirmed grade and the preview's
 * hash. The planner's own answers are the gateway's and tested there.
 *
 * NextIntlClientProvider with onError that throws: a key missing from
 * sv.json, or an ICU sentence its params do not fill, fails the test instead
 * of printing "years.foo" into a screen nobody looks at in English.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});
const post = api.post as unknown as Mock;

// The debounce is the wizard's own business; here every change previews at once.
vi.mock("./use-year-rollover", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-year-rollover")>()),
  useDebouncedValue: <T,>(value: T) => value,
}));

const year = {
  id: "y26",
  name: "2026/27",
  startDate: "2026-08-17",
  endDate: "2027-06-11",
  isActive: true,
  predecessorId: null,
  graduatingGradeLevel: null,
};
const groups: StudentGroup[] = [
  { id: "g-7a", academicYearId: "y26", name: "7A", kind: "CLASS", gradeLevel: 7 },
  { id: "g-8a", academicYearId: "y26", name: "8A", kind: "CLASS", gradeLevel: 8 },
  { id: "g-9a", academicYearId: "y26", name: "9A", kind: "CLASS", gradeLevel: 9 },
  // Another year's group of the same name: never one of this wizard's rows.
  { id: "g-old-7a", academicYearId: "y25", name: "7A", kind: "CLASS", gradeLevel: 7 },
];

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: [year], isLoading: false }),
  useGroups: () => ({ data: groups }),
  usePeople: () => ({ data: [{ id: "t-bo", firstName: "Bo", lastName: "Alm" }] }),
}));

const push = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
  useRouter: () => ({ push }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const HASH = "a".repeat(64);

/** A preview as the planner would answer the request, pared down to what the wizard reads. */
function previewFor(body: RolloverOptions, overrides: Partial<RolloverPreview> = {}): RolloverPreview {
  const g = body.graduatingGradeLevel ?? 9;
  return {
    source: { id: "y26", name: "2026/27", startDate: "2026-08-17", endDate: "2027-06-11" },
    target: { name: body.name, startDate: body.startDate, endDate: body.endDate, dateShiftDays: 364, crossesIsoWeek53: true },
    graduatingGradeLevel: g,
    graduatingGradeSource: body.graduatingGradeLevel === undefined ? "TIMPLAN" : "REQUEST",
    graduatingGradeConflict: null,
    groups: groups
      .filter((group) => group.academicYearId === "y26")
      .map((group) => ({
        sourceGroupId: group.id,
        sourceName: group.name,
        kind: group.kind,
        sourceGradeLevel: group.gradeLevel,
        outcome: (group.gradeLevel ?? 0) >= g ? "GRADUATE" : "PROMOTE",
        targetName: null,
        targetGradeLevel: null,
        intakeName: null,
        nameStatus: "PROMOTED",
        noGrade: false,
        error: null,
        collision: false,
        caseCollision: false,
        homePupils: 25,
        membersCopied: 0,
        membersExcluded: { graduating: 0, noSuccessor: 0 },
        membersStranded: 0,
        requirementsCarried: 12,
        volumeFindings: [],
        volumePlanName: null,
      })),
    requirements: {
      carried: 24,
      notCarried: 12,
      periodShifted: 2,
      periodBoundAnchored: 1,
      periodDropped: [],
      teachersCleared: [
        { sourceRequirementId: "r-1", subjectName: "Fysik", groupName: "8A", role: "TEACHER", teacherId: "t-bo", reason: "NOT_QUALIFIED" },
      ],
      qualificationWarnings: [],
      oddEvenRows: 0,
    },
    breaks: [
      {
        sourceBreakId: "b-host",
        name: "Höstlov",
        startDate: "2026-10-26",
        endDate: "2026-10-30",
        proposedStart: "2027-11-01",
        proposedEnd: "2027-11-05",
        anchor: "ISO_WEEK",
        fits: true,
        selected: (body.breaks ?? []).some((lov) => lov.sourceBreakId === "b-host"),
        startDateToWrite: null,
        endDateToWrite: null,
      },
    ],
    classRules: [],
    skipped: [
      { model: "MasterLesson", reason: "…", count: 140 },
      { model: "CalendarLesson", reason: "…", count: null },
    ],
    problems: [],
    blocking: false,
    planHash: HASH,
    ...overrides,
  };
}

function renderWizard(sourceYearId: string | null = "y26") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale="sv"
        messages={sv}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <RolloverWizard sourceYearId={sourceYearId} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const previewCalls = () =>
  post.mock.calls.filter(([path]) => String(path).endsWith("/rollover/preview")).map(([, body]) => body as RolloverOptions);

describe("RolloverWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    post.mockImplementation(async (path: string, body: RolloverOptions) =>
      path.endsWith("/preview") ? previewFor(body) : { academicYear: { name: body.name }, counts: { groups: 3, requirements: 24 }, planHash: HASH },
    );
  });

  it("starts from the source counted up a year, 52 weeks on, and previews exactly that", async () => {
    renderWizard();
    expect(screen.getByLabelText("Namn")).toHaveValue("2027/28");
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    expect(previewCalls().at(-1)).toEqual({
      name: "2027/28",
      startDate: "2027-08-16",
      endDate: "2028-06-09",
      carryTeachingGroups: true,
      carryTeachingGroupMembers: true,
      keepTeachers: true,
      carryClassRules: true,
    });
    // The grade is left to the server's default, and the default is shown as such.
    expect(await screen.findByText("Från den senast beslutade lokala timplanen.")).toBeInTheDocument();
  });

  it("names next year's groups from the mirror, and marks a collision on the keystroke", async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /Klasser och grupper/ }));

    const seventh = screen.getByLabelText("Nytt namn för 7A");
    expect(seventh).toHaveAttribute("placeholder", "8A");
    expect(screen.getByLabelText("Nytt namn för 8A")).toHaveAttribute("placeholder", "9A");
    // The nians graduate: no name field, only what happens to them.
    expect(screen.queryByLabelText("Nytt namn för 9A")).toBeNull();
    // Only this year's groups are rows; last year's 7A is not.
    expect(screen.getAllByLabelText(/^Vad .* blir$/)).toHaveLength(3);

    await user.type(seventh, "9A");
    expect(seventh).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Nytt namn för 8A")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText("Namnet finns redan")).toHaveLength(2);
    // And the typed name is what the next preview asks for.
    await waitFor(() =>
      expect(previewCalls().at(-1)?.groups).toEqual([{ sourceGroupId: "g-7a", name: "9A" }]),
    );
  });

  it("says what the activation does with each class's pupils by its outcome, and totals the leavers in the review", async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /Klasser och grupper/ }));
    const rowOfGroup = (name: string) => screen.getByLabelText(`Vad ${name} blir`).closest("tr")!;
    expect(await within(rowOfGroup("8A")).findByText("25 elever (flyttar vid aktiveringen)")).toBeInTheDocument();
    // 9A graduates: its pupils do not move into anything.
    expect(within(rowOfGroup("9A")).getByText("25 elever (går ut vid aktiveringen)")).toBeInTheDocument();
    expect(within(rowOfGroup("9A")).queryByText(/flyttar vid aktiveringen/)).toBeNull();

    await user.click(screen.getByRole("button", { name: /Granska/ }));
    expect(await screen.findByText("Vid aktiveringen går 25 elever ut och blir 0 elever utan klass.")).toBeInTheDocument();
  });

  it("offers a new intake class beside the promotion, for the lowest grade only", async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /Klasser och grupper/ }));

    await user.click(screen.getByRole("combobox", { name: "Vad 8A blir" }));
    expect(screen.queryByRole("option", { name: /ny klass för intaget/ })).toBeNull();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("combobox", { name: "Vad 7A blir" }));
    await user.click(screen.getByRole("option", { name: "Flyttas upp + ny klass för intaget" }));
    expect(
      screen.getByText(/8A fortsätter med klassens elever, och en ny 7A öppnas för intaget/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(previewCalls().at(-1)?.groups).toEqual([{ sourceGroupId: "g-7a", outcome: "INTAKE" }]),
    );
  });

  it("carries no lov until one is ticked, and then with the proposed dates", async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /Lov/ }));

    const box = await screen.findByRole("checkbox", { name: "Höstlov" });
    expect(box).not.toBeChecked();
    expect(screen.getByText("Förslag 2027-11-01 – 2027-11-05 (samma veckor)")).toBeInTheDocument();
    expect(previewCalls().every((body) => body.breaks === undefined)).toBe(true);

    await user.click(box);
    await waitFor(() => expect(previewCalls().at(-1)?.breaks).toEqual([{ sourceBreakId: "b-host" }]));
    expect(screen.getByRole("textbox", { name: "Första dag för Höstlov" })).toHaveValue("2027-11-01");
  });

  it("creates the year with the confirmed grade and the preview's hash, then goes back to the years", async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /Granska/ }));

    // The review names the teacher the preview only sends an id for.
    expect(await screen.findByText(/Bo Alm — Fysik, 8A: saknar behörighet för nästa årskurs/)).toBeInTheDocument();
    expect(screen.getByText(/Grundschemat \(140 lektioner\)/)).toBeInTheDocument();

    const create = screen.getByRole("button", { name: "Skapa 2027/28" });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/years"));
    const execute = post.mock.calls.find(([path]) => String(path) === "/api/v1/academic-years/y26/rollover");
    expect(execute?.[1]).toEqual({
      name: "2027/28",
      startDate: "2027-08-16",
      endDate: "2028-06-09",
      carryTeachingGroups: true,
      carryTeachingGroupMembers: true,
      keepTeachers: true,
      carryClassRules: true,
      // Not chosen by the admin, so the preview's default — and the hash it was computed with.
      graduatingGradeLevel: 9,
      planHash: HASH,
    });
    expect(toast.success).toHaveBeenCalledWith("2027/28 skapades med 3 grupper och 24 timplansposter.");
  });

  it("does not create on the second click of a double click on Nästa, and moves focus to the review", async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /Lov/ }));
    await user.dblClick(screen.getByRole("button", { name: "Nästa" }));
    expect(screen.getByRole("heading", { name: "Granska" })).toHaveFocus();
    // A second Enter lands on the heading, not on Skapa.
    await user.keyboard("{Enter}");
    expect(post.mock.calls.some(([path]) => String(path) === "/api/v1/academic-years/y26/rollover")).toBe(false);
    // Once the review has been on screen a moment, Skapa works.
    await waitFor(() => expect(screen.getByRole("button", { name: "Skapa 2027/28" })).toBeEnabled());
  });

  it("names the missing name instead of waiting for a preview that cannot come", async () => {
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    await user.clear(screen.getByLabelText("Namn"));
    expect(screen.getByLabelText("Namn")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Ange ett namn för det nya läsåret.")).toBeInTheDocument();
    expect(screen.getByText("Förhandsvisningen väntar: ge det nya läsåret ett namn i steg 1.")).toBeInTheDocument();
    expect(screen.queryByText("Förhandsvisningen uppdateras…")).toBeNull();
  });

  it("shows a blocking finding on its own step and will not create", async () => {
    post.mockImplementation(async (_path: string, body: RolloverOptions) =>
      previewFor(body, {
        problems: [{ code: "YEAR_NAME_TAKEN", blocking: true, params: { name: "2027/28" } }],
        blocking: true,
      }),
    );
    const user = userEvent.setup();
    renderWizard();
    expect(await screen.findByText("Det finns redan ett läsår som heter 2027/28.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Granska/ }));
    expect(await screen.findByRole("button", { name: "Skapa 2027/28" })).toBeDisabled();
  });

  it("is refused as a whole for a year already rolled, naming where it went", async () => {
    post.mockRejectedValue(
      new ApiError(409, "Läsåret 2026/27 har redan rullats vidare till 2027/28.", "YEAR_HAS_SUCCESSOR", {
        successorId: "y27",
        successor: "2027/28",
      }),
    );
    renderWizard();
    expect(await screen.findByRole("alert")).toHaveTextContent("Läsåret har redan rullats vidare till 2027/28.");
    expect(screen.queryByRole("button", { name: "Nästa" })).toBeNull();
  });

  it("says that nothing was created when the year moved after the preview", async () => {
    post.mockImplementation(async (path: string, body: RolloverOptions) => {
      if (path.endsWith("/preview")) return previewFor(body);
      throw new ApiError(409, "Läsåret har ändrats …", "ROLLOVER_PREVIEW_STALE");
    });
    const user = userEvent.setup();
    renderWizard();
    await waitFor(() => expect(previewCalls().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: /Granska/ }));
    const create = await screen.findByRole("button", { name: "Skapa 2027/28" });
    await waitFor(() => expect(create).toBeEnabled());
    await user.click(create);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Läsåret ändrades efter förhandsvisningen. Inget skapades — granska den nya förhandsvisningen och försök igen.",
      ),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("asks for a source year when it is given none", () => {
    renderWizard(null);
    const empty = screen.getByText("Inget läsår att rulla").closest("div")!.parentElement!;
    expect(within(empty).getByRole("link", { name: "Till läsåren" })).toHaveAttribute("href", "/admin/years");
    expect(post).not.toHaveBeenCalled();
  });
});
