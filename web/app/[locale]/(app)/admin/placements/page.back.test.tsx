import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacementBoard } from "@/lib/placement-board";
import PlacementsPage from "./page";

/**
 * Förlägg i veckan, what Generera and the grundschema point back with (A3): the card an address names is marked and given the
 * keyboard (and nothing opens), a card that is not there is said not to be, and the week says "Ändrat sedan senaste schemat"
 * when the förläggningar are no longer what the grundschema was written from. page.test.tsx is the week's own; this is the
 * part that comes from outside.
 */

const state = vi.hoisted(() => ({
  board: undefined as unknown,
  jobs: [] as Array<{ id: string; status: string; solverStatus: string | null; finishedAt: string | null; createdAt: string }>,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({
    year: { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true },
    active: { id: "y1" },
    successor: null,
    choose: vi.fn(),
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

const TUESDAY = "post-ma||60|2|10:00|ALL_WEEKS";
const THURSDAY = "post-ma||60|4|13:00|ALL_WEEKS";
const cardOf = (key: string) => document.querySelector<HTMLElement>(`[data-lesson-id='placement:${key}']`);
const selected = (card: HTMLElement | null) => card !== null && within(card).queryByText("selected") !== null;

let client: QueryClient;
const renderPage = (search = "") => {
  window.history.replaceState(null, "", `/sv/admin/placements${search}`);
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
const succeeded = (finishedAt = "2026-11-16T09:00:00.000Z") => ({ id: "j1", status: "SUCCEEDED", solverStatus: "OPTIMAL", finishedAt, createdAt: "2026-11-16T08:55:00.000Z" });

beforeEach(() => {
  state.board = board();
  state.jobs = [succeeded()];
  api.get.mockReset().mockImplementation(async () => structuredClone(state.board));
  api.put.mockReset();
});

afterEach(() => {
  window.history.replaceState(null, "", "/sv/admin/placements");
  vi.restoreAllMocks();
});

describe("the card an address names", () => {
  it("is marked, and given the keyboard, and nothing is opened", async () => {
    renderPage("?post=post-ma&day=4&start=13:00");
    await ready();
    await waitFor(() => expect(selected(cardOf(THURSDAY))).toBe(true));
    expect(cardOf(THURSDAY)).toBe(document.activeElement);
    expect(selected(cardOf(TUESDAY))).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("placement-link-missing")).not.toBeInTheDocument();
  });

  it("is found by the post, the day and the start, so a card of the same post on another day is not marked", async () => {
    renderPage("?year=y1&post=post-ma&day=2&start=10:00");
    await ready();
    await waitFor(() => expect(selected(cardOf(TUESDAY))).toBe(true));
    expect(selected(cardOf(THURSDAY))).toBe(false);
  });

  it("marks the first of two alike, which is the card with no number after its name", async () => {
    state.board = board({ placements: [row("row-a", 2, "10:00"), row("row-b", 2, "10:00")] });
    renderPage("?post=post-ma&day=2&start=10:00");
    await ready();
    await waitFor(() => expect(selected(cardOf(TUESDAY))).toBe(true));
    expect(selected(cardOf(`${TUESDAY}#2`))).toBe(false);
  });

  it("says so when no row is there any more (moved or removed since the run), and marks nothing", async () => {
    renderPage("?post=post-ma&day=3&start=09:00");
    await ready();
    expect(await screen.findByTestId("placement-link-missing")).toHaveTextContent("missing");
    expect(screen.getByTestId("placement-link-missing")).toHaveAttribute("role", "status");
    expect(document.querySelector("[data-lesson-id]:focus")).toBeNull();
    expect(selected(cardOf(TUESDAY))).toBe(false);
    expect(selected(cardOf(THURSDAY))).toBe(false);
  });

  it("says nothing is missing for an address that names no card: only a post (the dialog's own link), or a day and a start that are no place on the week", async () => {
    for (const search of ["?post=post-ma", "?post=post-ma&day=6&start=10:00", "?post=post-ma&day=2&start=25:00", "?post=post-ma&day=2", "?year=y1", ""]) {
      const { unmount } = renderPage(search);
      await ready();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByTestId("placement-link-missing"), search).not.toBeInTheDocument();
      expect(selected(cardOf(TUESDAY)), search).toBe(false);
      expect(selected(cardOf(THURSDAY)), search).toBe(false);
      unmount();
    }
  });

  it("leaves a block's lesson to the block's own card: an address with a block marks nothing and says nothing is missing", async () => {
    renderPage("?post=post-ma&day=4&start=13:00&block=b1");
    await ready();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(selected(cardOf(THURSDAY))).toBe(false);
    expect(screen.queryByTestId("placement-link-missing")).not.toBeInTheDocument();
  });

  it("looks once: a card the school moves afterwards is not said to be missing", async () => {
    renderPage("?post=post-ma&day=4&start=13:00");
    await ready();
    await waitFor(() => expect(selected(cardOf(THURSDAY))).toBe(true));
    state.board = board({ placements: [row("row-1", 2, "10:00"), row("row-2", 4, "14:00")] });
    await client.invalidateQueries();
    await waitFor(() => expect(cardOf("post-ma||60|4|14:00|ALL_WEEKS")).not.toBeNull());
    expect(screen.queryByTestId("placement-link-missing")).not.toBeInTheDocument();
  });

  it("ends the mark when the school opens a card", async () => {
    renderPage("?post=post-ma&day=4&start=13:00");
    await ready();
    await waitFor(() => expect(selected(cardOf(THURSDAY))).toBe(true));
    await userEvent.click(cardOf(TUESDAY)!);
    await waitFor(() => expect(selected(cardOf(TUESDAY))).toBe(true));
    expect(selected(cardOf(THURSDAY))).toBe(false);
  });
});

describe("Ändrat sedan senaste schemat", () => {
  const note = () => screen.queryByTestId("placement-since-run");

  it("says nothing when the rows are what the grundschema was written from", async () => {
    renderPage();
    await ready();
    expect(note()).not.toBeInTheDocument();
  });

  it("says it, with a way to Generera, for a row laid after the run", async () => {
    state.board = board({ placements: [row("row-1", 2, "10:00"), row("row-2", 4, "13:00"), row("row-3", 5, "08:00", { changedAt: "2026-11-16T10:00:00.000Z" })] });
    renderPage();
    await ready();
    const shown = await screen.findByTestId("placement-since-run");
    expect(shown).toHaveTextContent("changed");
    const link = within(shown).getByRole("link", { name: "toGenerate" });
    expect(link).toHaveAttribute("href", "/admin/generate");
    expect(link).toHaveAttribute("data-writes", "SCHEMALAGGNING");
  });

  it("says it for a row that was changed after the run, and for one that was taken away", async () => {
    state.board = board({ placements: [row("row-1", 2, "10:00"), row("row-2", 4, "13:00", { changedAt: "2026-11-16T10:00:00.000Z" })] });
    const { unmount } = renderPage();
    await ready();
    expect(await screen.findByTestId("placement-since-run")).toBeInTheDocument();
    unmount();
    state.board = board({ placements: [row("row-1", 2, "10:00")] });
    renderPage();
    await ready();
    expect(await screen.findByTestId("placement-since-run")).toBeInTheDocument();
  });

  it("is above the summary and under the row that says a run is going, and is left out while one is", async () => {
    state.board = board({ placements: [row("row-1", 2, "10:00")] });
    const { unmount } = renderPage();
    await ready();
    const shown = await screen.findByTestId("placement-since-run");
    const summary = screen.getByTestId("placement-summary");
    expect(shown.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();
    state.jobs = [...state.jobs, { id: "j2", status: "RUNNING", solverStatus: null, finishedAt: null, createdAt: new Date().toISOString() }];
    renderPage();
    await ready();
    expect(await screen.findByTestId("placement-running")).toBeInTheDocument();
    expect(note()).not.toBeInTheDocument();
  });

  it("says nothing before the first schema: no run that laid a week and nothing written from a förläggning (the week's own sentence stands)", async () => {
    state.jobs = [];
    state.board = board({ timetable: { placedLessons: 0, writtenAt: null } });
    renderPage();
    await ready();
    expect(note()).not.toBeInTheDocument();
    expect(screen.getByText("beforeAfter")).toBeInTheDocument();
  });

  it("is a schema all the same when only a schemaförslag wrote it (a grundschema with lessons from a förläggning, no run in the history)", async () => {
    state.jobs = [];
    state.board = board({ placements: [row("row-1", 2, "10:00")], timetable: { placedLessons: 2, writtenAt: "2026-11-16T09:00:00.000Z" } });
    renderPage();
    await ready();
    expect(await screen.findByTestId("placement-since-run")).toBeInTheDocument();
  });

  it("measures against the run when the gateway is older and the board has no timetable", async () => {
    state.board = { ...board(), timetable: undefined };
    const { unmount } = renderPage();
    await ready();
    expect(note()).not.toBeInTheDocument();
    unmount();
    state.board = { ...board({ placements: [row("row-1", 2, "10:00", { changedAt: "2026-11-16T10:00:00.000Z" })] }), timetable: undefined };
    renderPage();
    await ready();
    expect(await screen.findByTestId("placement-since-run")).toBeInTheDocument();
  });
});
