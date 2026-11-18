import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacementBoard } from "@/lib/placement-board";
import PlacementsPage from "./page";

/**
 * Förlägg i veckan, "Visa senaste schemat": the lessons the last Generera laid, drawn pale behind the week for what is picked. Off, nothing
 * is read; on with nothing picked, it says what to pick; on with a class picked, it reads the latest schedule and draws that class's lessons
 * (and the week picked narrows them). A reader has the switch too: it is a read.
 */

const state = vi.hoisted(() => ({
  board: undefined as unknown,
  latest: undefined as unknown,
  latestFails: false,
  failWeekTools: false,
  readOnly: false,
  yearId: "y1",
  jobs: [] as Array<{ id: string; status: string; solverStatus: string | null; finishedAt: string | null; createdAt: string }>,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
// The week's own tools can be made not to arrive (a chunk that does not come), as the page's lazy hook would see it.
vi.mock("@/lib/use-lazy-module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-lazy-module")>();
  const hook = actual.useLazyModule as (...args: unknown[]) => unknown;
  return {
    ...actual,
    useLazyModule: (load: () => Promise<unknown>, ...rest: unknown[]) =>
      hook(() => (state.failWeekTools && String(load).includes("placement-week-tools") ? Promise.reject(new Error("Failed to load chunk")) : load()), ...rest),
  };
});
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({
    year: { id: state.yearId, name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: state.yearId === "y1" },
    active: { id: "y1" },
    successor: null,
    choose: vi.fn(),
    rosters: null,
    rostersFailed: false,
  }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { adminProfile: state.readOnly ? "LASARE" : "SCHEMALAGGARE" } }),
  useReadOnly: () => state.readOnly,
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

const generated = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  dayOfWeek: 3,
  startTime: "09:00",
  endTime: "10:00",
  studentGroupId: "g-7a",
  extraGroupIds: [] as string[],
  subjectId: "s-ma",
  teacherId: "anna",
  coTeacherId: null,
  roomId: "r-a12",
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  locked: false,
  generated: true,
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
const asked = () => api.get.mock.calls.map((call) => String(call[0])).filter((path) => path.includes("/placements/latest"));
const ghosts = () => screen.queryAllByTestId("placement-ghost");
const pickClass = async () => {
  await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
};
const turnOn = async () => userEvent.click(screen.getByRole("checkbox", { name: "label" }));

beforeEach(() => {
  state.board = board();
  state.latest = { academicYearId: "y1", lessons: [generated("g1"), generated("g2", { dayOfWeek: 4, startTime: "11:00", endTime: "12:00", subjectId: "s-sv" }), generated("g3", { studentGroupId: "g-7b" })] };
  state.latestFails = false;
  state.failWeekTools = false;
  state.readOnly = false;
  state.yearId = "y1";
  state.jobs = [];
  api.get.mockReset().mockImplementation(async (path: string) => {
    if (path.includes("/placements/latest")) {
      if (state.latestFails) throw new Error("boom");
      return structuredClone(state.latest);
    }
    return structuredClone(state.board);
  });
  api.put.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the switch for the latest schedule", () => {
  it("is off to begin with, and nothing of the latest schedule is read, drawn or said", async () => {
    renderPage();
    await ready();
    expect(screen.getByRole("checkbox", { name: "label" })).not.toBeChecked();
    expect(asked()).toEqual([]);
    expect(ghosts()).toEqual([]);
    expect(screen.queryByTestId("placement-latest-said")).not.toBeInTheDocument();
    // The legend's line for the pale lessons is there only while they are.
    expect(within(screen.getByRole("list", { name: "legend" })).queryByText("legend")).not.toBeInTheDocument();
  });

  it("says what to pick when it is on and nothing is: and reads nothing, since nothing would be drawn", async () => {
    renderPage();
    await ready();
    await turnOn();
    expect(screen.getByTestId("placement-latest-said")).toHaveTextContent("needsFilter");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(asked()).toEqual([]);
    expect(ghosts()).toEqual([]);
  });

  it("draws the picked class's lessons pale behind the week, says how many, and names them for a screen reader", async () => {
    renderPage();
    await ready();
    await turnOn();
    await pickClass();
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    expect(asked()).toEqual(["/api/v1/teaching-requirements/placements/latest?academicYearId=y1"]);
    expect(screen.getByTestId("placement-latest-said")).toHaveTextContent("shown(2)");
    expect(screen.getAllByRole("img").map((element) => element.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining(["ghost(Matematik, 7A · A. Ek, A12, 09:00–10:00)"]),
    );
    expect(screen.getByRole("list", { name: "legend" })).toHaveTextContent("legend");
    // The förläggningar are still the week's cards, and the ghosts are not cards: nothing to open or drag.
    expect(document.querySelector("[data-lesson-id^='latest:']")).toBeNull();
    expect(document.querySelector("[data-lesson-id^='placement:']")).not.toBeNull();
  });

  it("takes the lessons away when it is turned off, and reads the schedule once however often it is turned on and off", async () => {
    renderPage();
    await ready();
    await turnOn();
    await pickClass();
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    await turnOn();
    expect(ghosts()).toEqual([]);
    expect(screen.queryByTestId("placement-latest-said")).not.toBeInTheDocument();
    await turnOn();
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    expect(asked()).toHaveLength(1);
  });

  it("says when the latest schedule has nothing for what is picked, and when it did not come", async () => {
    state.latest = { academicYearId: "y1", lessons: [generated("other", { studentGroupId: "g-7b" })] };
    renderPage();
    await ready();
    await turnOn();
    await pickClass();
    await waitFor(() => expect(screen.getByTestId("placement-latest-said")).toHaveTextContent("none"));
    expect(ghosts()).toEqual([]);
  });

  it("says that the latest schedule did not come, and draws nothing", async () => {
    state.latestFails = true;
    renderPage();
    await ready();
    await turnOn();
    await pickClass();
    await waitFor(() => expect(screen.getByTestId("placement-latest-said")).toHaveTextContent("failed"));
    expect(ghosts()).toEqual([]);
  });

  it("is read for the läsår on screen: another läsår is another read, and nothing of the first one's schedule is drawn for it (review of #345/#347)", async () => {
    const other = { academicYearId: "y2", lessons: [generated("n1", { dayOfWeek: 5, startTime: "13:00", endTime: "14:00" })] };
    api.get.mockImplementation(async (path: string) => {
      if (path.includes("/placements/latest")) return structuredClone(path.includes("academicYearId=y2") ? other : state.latest);
      return structuredClone(state.board);
    });
    const { rerender } = renderPage();
    await ready();
    await turnOn();
    await pickClass();
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    state.yearId = "y2";
    rerender(
      <QueryClientProvider client={client}>
        <PlacementsPage />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(asked()).toContain("/api/v1/teaching-requirements/placements/latest?academicYearId=y2"));
    await waitFor(() => expect(ghosts()).toHaveLength(1));
    expect(ghosts()[0]!.getAttribute("aria-label")).toContain("13:00–14:00");
  });

  it("says once that the page's tools did not come when the week's own do not, and does not stand on 'reading' for ever (review of #347, LÅG-5)", async () => {
    state.failWeekTools = true;
    renderPage();
    await ready();
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("toolsFailed");
  });

  it("is the reader's too: it is a read, and a reader with no card in the week still sees the schedule's lessons", async () => {
    state.readOnly = true;
    state.board = board({ placements: [] });
    renderPage();
    await ready();
    expect(screen.getByRole("checkbox", { name: "label" })).toBeInTheDocument();
    await turnOn();
    await pickClass();
    await waitFor(() => expect(ghosts()).toHaveLength(2));
    // The grid is drawn for a reader with no card, as there is something to see in it: the lessons, and nothing of them to open or drag.
    expect(screen.getAllByRole("img").length).toBeGreaterThanOrEqual(2);
  });
});
