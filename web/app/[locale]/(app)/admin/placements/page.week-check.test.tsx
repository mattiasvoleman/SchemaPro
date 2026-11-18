import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacementBoard } from "@/lib/placement-board";
import { ApiError } from "@/lib/api";
import { placementBoardKey } from "@/lib/placement-board-queries";
import PlacementsPage from "./page";

/**
 * Kontrollera veckan on Förlägg i veckan: the button beside the way to Generera, the answer under the header, and that the
 * answer is of the week as it stood (a save drops it, another year drops it, one that comes late is dropped). The scaffolding
 * is page.back.test.tsx's, kept apart so that the other features of this page do not edit one file.
 */

const state = vi.hoisted(() => ({
  board: undefined as unknown,
  jobs: [] as Array<{ id: string; status: string; solverStatus: string | null; finishedAt: string | null; createdAt: string }>,
}));

/** The year choice the page was given, which a test calls to change year. */
const choose = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({
    year: { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true },
    active: { id: "y1" },
    successor: null,
    choose,
    rosters: null,
    rostersFailed: false,
  }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { adminProfile: "SCHEMALAGGARE" } }),
  useReadOnly: () => false,
}));
vi.mock("@/lib/queries", () => ({
  useGroups: () => ({ data: [{ id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 }], isLoading: false }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik", color: "#2563eb" }], isLoading: false }),
  useRooms: () => ({ data: [{ id: "r-a12", name: "A12" }], isLoading: false }),
  usePeople: () => ({ data: [{ id: "anna", role: "TEACHER", firstName: "Anna", lastName: "Ek", isActive: true }], isLoading: false }),
  useConstraints: () => ({ data: [] }),
  useFrameTimes: () => ({ data: [] }),
  useGroupMemberships: () => ({ data: [] }),
  useRoomPreferences: () => ({ data: [] }),
  useOptimizationHistory: () => ({ data: state.jobs }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
      { has: () => true },
    ),
}));

const row = (id: string, day: number, start: string, over: Partial<PlacementBoard["placements"][number]> = {}): PlacementBoard["placements"][number] => ({
  id,
  requirementId: "post-ma",
  dayOfWeek: day,
  startTime: start,
  endTime: `${String(Number(start.slice(0, 2)) + 1).padStart(2, "0")}${start.slice(2)}`,
  minutes: 60,
  roomId: "r-a12",
  roomName: "A12",
  recurrence: "ALL_WEEKS",
  teacherId: null,
  changedAt: "2026-11-16T08:00:00.000Z",
  verdict: { ok: true },
  ...over,
});

const board = (over: Partial<PlacementBoard> = {}): PlacementBoard => ({
  academicYearId: "y1",
  timetable: { placedLessons: 2, writtenAt: "2026-11-16T09:00:00.000Z" },
  // No parallel block in this world (the board of a gateway before the blocks, or a year with none).
  blocks: [],
  posts: [
    {
      id: "post-ma",
      studentGroupId: "g-7a",
      subjectId: "s-ma",
      teacherId: "anna",
      coTeacherId: null,
      recurrence: "ALL_WEEKS",
      startDate: null,
      endDate: null,
      cannotPlace: null,
      parts: [{ teacherId: "anna", minutes: 60, count: 3, locked: 0, placed: 2, left: 1, cannotPlace: null }],
      rowsKey: "k000000000000001",
    },
  ],
  placements: [row("row-1", 2, "10:00"), row("row-2", 4, "13:00")],
  kept: [],
  meals: [],
  ...over,
});


let client: QueryClient;
const renderPage = () => {
  window.history.replaceState(null, "", "/sv/admin/placements");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PlacementsPage />
    </QueryClientProvider>,
  );
};
const ready = async () => {
  await screen.findByTestId("placement-summary");
};
const checkButton = () => screen.getByRole("button", { name: /^(button|checking)$/ });
const region = () => screen.queryByRole("region", { name: "title" });

/** The answer of POST week-check for a week with åk 7 at 94 %. */
const TIGHT = {
  verdict: "TIGHT",
  years: [{ year: 7, demandMinutes: 2068, capacityMinutes: 2200, percent: 94, over: false }],
  conflicts: {
    summary: "",
    summaryCode: "",
    summaryParams: {},
    conflicts: [
      {
        category: "REQUIREMENT_DEMAND",
        code: "TIGHT_WEEK_LOAD",
        message: "Year 7 needs at least 2068 of the 2200 minutes (94 %).",
        params: { grades: "7", demandMinutes: 2068, capacityMinutes: 2200, percent: 94 },
        resourceNames: [],
      },
    ],
  },
  skipped: ["LUNCH_STAGE"],
  elapsedMs: 310,
  checkedBy: "ENGINE",
};

beforeEach(() => {
  state.board = board();
  state.jobs = [];
  choose.mockReset();
  api.get.mockReset().mockImplementation(async () => structuredClone(state.board));
  api.put.mockReset();
  api.post.mockReset().mockResolvedValue(TIGHT);
});

afterEach(() => {
  window.history.replaceState(null, "", "/sv/admin/placements");
  vi.restoreAllMocks();
});

describe("the button", () => {
  it("is not pressed for the school: nothing is asked when the page opens", async () => {
    renderPage();
    await ready();

    expect(api.post).not.toHaveBeenCalled();
    expect(region()).toBeNull();
  });

  it("carries the areas of its route, as Generera's button does, and is open once the week is drawn", async () => {
    renderPage();
    await ready();

    expect(checkButton()).toHaveAttribute("data-writes", "SCHEMALAGGNING DRIFT");
    expect(checkButton()).toBeEnabled();
  });

  it("is held until the week is drawn: an answer is of a week, and there is none yet", async () => {
    let drawn: (board: unknown) => void = () => undefined;
    api.get.mockReset().mockImplementation(() => new Promise((resolve) => (drawn = resolve)));
    renderPage();

    await waitFor(() => expect(checkButton()).toBeDisabled());
    expect(api.post).not.toHaveBeenCalled();

    await act(async () => drawn(structuredClone(state.board)));
    await waitFor(() => expect(checkButton()).toBeEnabled());
  });

  it("asks for the year shown, writes nothing, and says åk 7 at 94 % under the header, with the row a refused run carries", async () => {
    renderPage();
    await ready();

    await userEvent.setup().click(checkButton());

    // The module that asks is loaded when somebody asks, so the request follows the click.
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/v1/optimization/week-check", { academicYearId: "y1" }));
    const panel = await screen.findByRole("region", { name: "title" });
    expect(within(panel).getByText("verdict.TIGHT")).toBeInTheDocument();
    expect(within(panel).getByText("yearTight(7|94)")).toBeInTheDocument();
    expect(within(panel).getByText("TIGHT_WEEK_LOAD(7|2068|2200|94)")).toBeInTheDocument();
    // A page of förläggningar writes through the dialog and the grid, never through this.
    expect(api.put).not.toHaveBeenCalled();
    // And no question: there is no run here to ask before.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is held and says so while it asks", async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.post.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    renderPage();
    await ready();

    await userEvent.setup().click(checkButton());

    await waitFor(() => expect(checkButton()).toBeDisabled());
    expect(checkButton()).toHaveTextContent("checking");
    expect(await screen.findByRole("region", { name: "title" })).toHaveAttribute("aria-busy", "true");

    await act(async () => answer({ ...TIGHT, verdict: "OK", years: [], conflicts: null }));
    await waitFor(() => expect(checkButton()).toBeEnabled());
    expect(within(screen.getByRole("region", { name: "title" })).getByText("verdict.OK")).toBeInTheDocument();
  });

  it("says in words that an engine older than the API cannot check yet, and a payload refusal in its own sentence", async () => {
    api.post.mockRejectedValueOnce(new ApiError(503, "Schemamotorn är äldre än API:t.", "ENGINE_LACKS_WEEK_CHECK"));
    renderPage();
    await ready();
    await userEvent.setup().click(checkButton());
    expect(await screen.findByText("unavailableOlder")).toBeInTheDocument();

    api.post.mockRejectedValueOnce(new ApiError(400, "Student group g brings 30 students to lunch.", "LUNCH_HEADCOUNT_EXCEEDS_SEATS", { seats: 20 }));
    await userEvent.setup().click(checkButton());
    expect(await screen.findByText("LUNCH_HEADCOUNT_EXCEEDS_SEATS(20)")).toBeInTheDocument();
    expect(screen.getByText("refusedTitle")).toBeInTheDocument();
  });
});

describe("the answer is of the week as it stood", () => {
  const asked = async () => {
    renderPage();
    await ready();
    await userEvent.setup().click(checkButton());
    await screen.findByRole("region", { name: "title" });
  };

  it("is dropped when a save changes the board", async () => {
    await asked();

    act(() => {
      const changed = board({ placements: [row("row-1", 2, "10:00")], timetable: { placedLessons: 1, writtenAt: "2026-11-16T09:00:00.000Z" } });
      client.setQueryData(placementBoardKey("y1"), changed);
    });

    await waitFor(() => expect(region()).toBeNull());
  });

  it("stays when the board is read again and is the same", async () => {
    await asked();

    await act(async () => {
      await client.refetchQueries({ queryKey: placementBoardKey("y1") });
    });

    expect(region()).toBeInTheDocument();
  });

  it("is dropped when it comes back after the board changed, and is not drawn late", async () => {
    let answer: (value: unknown) => void = () => undefined;
    api.post.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    renderPage();
    await ready();
    await userEvent.setup().click(checkButton());
    await waitFor(() => expect(checkButton()).toBeDisabled());

    act(() => {
      client.setQueryData(placementBoardKey("y1"), board({ placements: [] }));
    });
    await waitFor(() => expect(checkButton()).toBeEnabled());
    await act(async () => answer(TIGHT));

    expect(region()).toBeNull();
  });
});
