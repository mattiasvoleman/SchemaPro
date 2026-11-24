import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { BoardPlacement, PlacementBoard } from "@/lib/placement-board";
import PlacementsPage from "./page";

/**
 * Förlägg i veckan. What the gateway counts and judges is its own specs'; here the page is held to what it makes of
 * the answer and what it does with a gesture: the figures it puts first, a förläggning that no longer holds said in
 * words and not by colour alone, the lessons Generera keeps drawn apart from the förläggningar, a post the link in
 * the dialog names reached, every state of the read — and the three ways of laying a lesson (a brick pulled, a brick
 * and a time pressed, the keyboard), moving and removing one, undo and redo, a refused drop that says why and leaves
 * the brick where it was, and a post somebody else has written (409 REQUIREMENT_PLACEMENTS_STALE).
 *
 * The gateway is a small fake of the PUT (a post's list replaced with new ids and a new key; `baseKey` checked), so
 * that the page's own chain of keys is what is tested, not a hand-written answer.
 */

const state = vi.hoisted(() => ({
  board: undefined as unknown,
  boardMode: "ok" as "ok" | "loading" | "error",
  year: { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true } as unknown,
  peopleLoading: false,
  adminProfile: "SCHEMALAGGARE" as string | null,
  readOnly: false,
  jobs: [] as Array<{ id: string; status: string; createdAt: string }>,
  refuse: null as null | ((path: string, body: { placements: unknown[]; baseKey?: string }) => unknown),
  keyCount: 0,
  rowCount: 0,
  /** The fake PUT lets a row the post already had that does not hold stand, and names it in the answer, as the gateway does (MEDEL-2 of the review of #326). Off: every row of an answer holds. */
  carryFailing: false,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
/**
 * The lazy modules of the page (lib/use-lazy-module.ts), held back or failed by a test that wants the moment before they arrive. By default
 * they come at once, as they do for every other test of this file.
 */
const tools = vi.hoisted(() => ({ gate: Promise.resolve() as Promise<void>, failDragTools: false, fetched: [] as string[] }));
vi.mock("@/lib/use-lazy-module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-lazy-module")>();
  return {
    ...actual,
    useLazyModule: <T,>(load: () => Promise<T>, onError?: (error: unknown) => void, enabled?: boolean) =>
      actual.useLazyModule(
        () => {
          tools.fetched.push(String(load));
          return tools.failDragTools && String(load).includes("placement-drag-tools") ? Promise.reject(new Error("Failed to load chunk")) : tools.gate.then(load);
        },
        onError,
        enabled,
      ),
  };
});
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({ year: state.year, active: state.year, successor: null, choose: vi.fn(), rosters: null, rostersFailed: false }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { adminProfile: state.adminProfile } }),
  useReadOnly: () => state.readOnly,
}));
vi.mock("@/lib/queries", () => ({
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-7b", academicYearId: "y1", name: "7B", kind: "CLASS", gradeLevel: 7 },
    ],
    isLoading: false,
  }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik", color: "#2563eb" }, { id: "s-sl", name: "Slöjd", color: null }], isLoading: false }),
  useRooms: () => ({ data: [{ id: "r-a12", name: "A12" }, { id: "r-sl", name: "Slöjdsalen" }], isLoading: false }),
  usePeople: () => ({
    data: [
      { id: "anna", role: "TEACHER", firstName: "Anna", lastName: "Ek", isActive: true },
      { id: "bo", role: "TEACHER", firstName: "Bo", lastName: "Lind", isActive: true },
      // An administrator who teaches (Users.teaches), and one who does not.
      { id: "maja", role: "SCHOOL_ADMIN", firstName: "Maja", lastName: "Mark", isActive: true, teaches: true },
      { id: "rolf", role: "SCHOOL_ADMIN", firstName: "Rolf", lastName: "Rektor", isActive: true },
    ],
    isLoading: state.peopleLoading,
  }),
  useConstraints: () => ({ data: [] }),
  useFrameTimes: () => ({ data: [] }),
  useGroupMemberships: () => ({ data: [] }),
  useRoomPreferences: () => ({ data: [] }),
  useOptimizationHistory: () => ({ data: state.jobs }),
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
// Keys echoed with their values: the sentences are the messages' own tests'.
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
      { has: () => true },
    ),
}));

const ANNA_ROW = "post-ma||60|2|10:00|ALL_WEEKS";
const BAD_ROW = "post-ma||60|4|13:00|ODD_WEEKS";
const cardOf = (key: string) => document.querySelector<HTMLElement>(`[data-lesson-id='placement:${key}']`);

const baseBoard = (): PlacementBoard => ({
  academicYearId: "y1",
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
      parts: [{ teacherId: "anna", minutes: 60, count: 3, locked: 1, placed: 1, left: 1, cannotPlace: null }],
      rowsKey: "k000000000000001",
    },
    {
      id: "post-sl",
      studentGroupId: "g-7b",
      subjectId: "s-sl",
      teacherId: "bo",
      coTeacherId: null,
      recurrence: "ALL_WEEKS",
      startDate: "2026-08-24",
      endDate: "2026-12-20",
      cannotPlace: "BLOCK",
      parts: [{ teacherId: "bo", minutes: 80, count: 1, locked: 0, placed: 0, left: 1, cannotPlace: null }],
      rowsKey: "e3b0c44298fc1c14",
    },
  ],
  placements: [
    {
      id: "row-ma",
      requirementId: "post-ma",
      dayOfWeek: 2,
      startTime: "10:00",
      endTime: "11:00",
      minutes: 60,
      roomId: "r-a12",
      roomName: "A12",
      recurrence: "ALL_WEEKS",
      teacherId: null,
      changedAt: "2026-11-13T08:00:00.000Z",
      verdict: { ok: true },
    },
    {
      id: "row-bad",
      requirementId: "post-ma",
      dayOfWeek: 4,
      startTime: "13:00",
      endTime: "14:00",
      minutes: 60,
      roomId: "r-a12",
      roomName: "A12",
      recurrence: "ODD_WEEKS",
      teacherId: null,
      changedAt: "2026-11-13T08:05:00.000Z",
      verdict: { ok: false, reason: "TEACHER", params: { className: "7B", subjectName: "Slöjd", day: 4, start: "13:00", end: "14:00" } },
    },
  ],
  kept: [
    {
      id: "k-1",
      dayOfWeek: 1,
      startTime: "08:00",
      endTime: "09:00",
      studentGroupId: "g-7a",
      extraGroupIds: [],
      subjectId: "s-sl",
      teacherId: "bo",
      coTeacherId: null,
      roomId: "r-sl",
      recurrence: "ALL_WEEKS",
      startDate: null,
      endDate: null,
      locked: true,
      generated: false,
    },
  ],
  meals: [{ id: "m-1", studentGroupId: "g-7a", dayOfWeek: 2, startTime: "11:00", endTime: "11:30", startDate: null, endDate: null }],
  blocks: [],
});

const board = (over: Partial<PlacementBoard> = {}): PlacementBoard => ({ ...baseBoard(), ...over });

/** The fake PUT: the post's list replaced with new ids and a new key, `baseKey` checked, and the board the next read gives is the board it left. */
function fakePut(path: string, body: { placements: Array<Record<string, unknown>>; baseKey?: string }) {
  if (state.refuse) {
    const answer = state.refuse(path, body);
    if (answer !== undefined) return Promise.reject(answer);
  }
  const current = state.board as PlacementBoard;
  const postId = /teaching-requirements\/([^/]+)\/placements/.exec(path)![1]!;
  const post = current.posts.find((entry) => entry.id === postId)!;
  if (body.baseKey !== undefined && body.baseKey !== post.rowsKey) {
    return Promise.reject(new ApiError(409, "stale", "REQUIREMENT_PLACEMENTS_STALE", { requirementId: postId }));
  }
  const rowsKey = `k${String(++state.keyCount).padStart(15, "0")}`.replace(/^k0/, "k9");
  const written = body.placements.map((input) => {
    const startMinutes = Number(String(input["startTime"]).slice(0, 2)) * 60 + Number(String(input["startTime"]).slice(3, 5));
    const end = startMinutes + Number(input["minutes"]);
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const roomId = (input["roomId"] as string | null | undefined) ?? null;
    return {
      id: `n-${++state.rowCount}`,
      requirementId: postId,
      dayOfWeek: input["dayOfWeek"] as number,
      startTime: String(input["startTime"]),
      endTime: clock(end),
      minutes: input["minutes"] as number,
      roomId,
      roomName: roomId === "r-a12" ? "A12" : roomId === "r-sl" ? "Slöjdsalen" : null,
      recurrence: input["recurrence"] as BoardPlacement["recurrence"],
      teacherId: (input["teacherId"] as string | undefined) ?? null,
    };
  });
  // A pair of halves is ONE lesson in two places (placement-fit.ts), a lone half none, on an every-week post.
  const whole = written.filter((row) => row.recurrence === "ALL_WEEKS").length;
  const odd = written.filter((row) => row.recurrence === "ODD_WEEKS").length;
  const even = written.filter((row) => row.recurrence === "EVEN_WEEKS").length;
  const placed = whole + Math.min(odd, even);
  state.board = {
    ...current,
    placements: [
      ...current.placements.filter((row) => row.requirementId !== postId),
      ...written.map((row) => ({ ...row, changedAt: "2026-11-16T09:00:00.000Z", verdict: { ok: true } })),
    ],
    posts: current.posts.map((entry) =>
      entry.id === postId
        ? { ...entry, rowsKey, parts: entry.parts.map((part) => ({ ...part, placed, left: Math.max(0, part.count - part.locked - placed) })) }
        : entry,
    ),
  };
  const sameRow = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    ["dayOfWeek", "startTime", "minutes", "recurrence"].every((field) => a[field] === b[field]) &&
    (a["roomId"] ?? null) === (b["roomId"] ?? null) &&
    (a["teacherId"] ?? null) === (b["teacherId"] ?? null);
  const unused = current.placements.filter((row) => row.requirementId === postId && !row.verdict.ok);
  const verdicts = written.map((row, index) => {
    if (!state.carryFailing) return { index, ok: true };
    const at = unused.findIndex((was) => sameRow(was as unknown as Record<string, unknown>, row));
    if (at === -1) return { index, ok: true };
    const [was] = unused.splice(at, 1);
    return { index, ...was!.verdict };
  });
  state.board = {
    ...(state.board as PlacementBoard),
    placements: (state.board as PlacementBoard).placements.map((row) => {
      const at = written.findIndex((entry) => entry.id === row.id);
      return at === -1 ? row : { ...row, verdict: verdicts[at] as BoardPlacement["verdict"] };
    }),
  };
  return Promise.resolve({ placements: written, verdicts, rowsKey });
}

let client: QueryClient;
const tree = () => (
  <QueryClientProvider client={client}>
    <PlacementsPage />
  </QueryClientProvider>
);
const renderPage = () => render(tree());

beforeEach(() => {
  state.board = board();
  state.boardMode = "ok";
  state.peopleLoading = false;
  state.adminProfile = "SCHEMALAGGARE";
  state.readOnly = false;
  tools.fetched.length = 0;
  state.jobs = [];
  state.refuse = null;
  state.keyCount = 0;
  state.rowCount = 0;
  state.carryFailing = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset().mockImplementation(async () => {
    if (state.boardMode === "loading") return new Promise(() => undefined);
    if (state.boardMode === "error") throw new ApiError(500, "down");
    return structuredClone(state.board);
  });
  api.put.mockReset().mockImplementation(fakePut);
  window.history.replaceState(null, "", "/sv/admin/placements");
});

afterEach(() => {
  vi.restoreAllMocks();
  tools.gate = Promise.resolve();
  tools.failDragTools = false;
});

const posts = () => screen.getAllByTestId("placement-post");
const ready = async () => {
  await screen.findByTestId("placement-summary");
};

/** jsdom has no layout: 56 px of time axis and five columns of 100 px, 08:00 to 18:00 at 1.1 px a minute (the grid's own test pins the same). */
const RECT = { x: 0, y: 0, top: 0, left: 0, right: 556, bottom: 660, width: 556, height: 660, toJSON: () => ({}) } as DOMRect;
const pinGeometry = () => vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
/** A pointer position over a day (1–5) and a clock time, on the pinned geometry. */
const at = (day: number, hour: number, minute = 0) => ({ clientX: 56 + (day - 1) * 100 + 50, clientY: Math.round(((hour * 60 + minute - 480) * 1.1)) });
const columns = () => Array.from(document.querySelectorAll<HTMLElement>("[data-writes-inert='SCHEMALAGGNING DRIFT']"));
const bricks = () => Array.from(document.querySelectorAll<HTMLElement>("[data-brick]"));
/** Nothing is written: asked after the page has had the time to start a write it should not (a write is a few microtasks away). */
const noWrite = async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(api.put).not.toHaveBeenCalled();
};
const lastPut = () => api.put.mock.calls.at(-1) as [string, { placements: Array<Record<string, unknown>>; baseKey?: string }];

describe("the figures", () => {
  it("says first how many rows the year holds and how many lessons are left to lay", async () => {
    renderPage();
    await ready();
    // Two rows; one lesson left in each post (1 + 1).
    expect(screen.getByTestId("placement-summary")).toHaveTextContent("summary(2|2)");
  });

  it("names the rows that no longer hold, each with the gateway's reason, in a notice that is read out", async () => {
    renderPage();
    await ready();
    const notice = screen.getByText("failingTitle(1)").closest('[role="alert"]')!;
    const item = within(notice as HTMLElement).getByTestId("failing-row");
    expect(item).toHaveTextContent("Matematik 7A");
    // The reason is the dialog's sentence for it (verdict.TEACHER), with what the judge says is in the way.
    expect(item).toHaveTextContent("verdict.TEACHER");
  });

  it("says nothing failed when every row holds, and that nothing is placed when there is none", async () => {
    state.board = board({ placements: [board().placements[0]!] });
    const { unmount } = renderPage();
    await ready();
    expect(screen.queryByText(/failingTitle/)).not.toBeInTheDocument();
    unmount();
    state.board = board({ placements: [] });
    client.clear();
    renderPage();
    expect(await screen.findByText("noneTitle")).toBeInTheDocument();
  });

  it("says that a row hidden by the filters is not shown among the rows that no longer hold (review of #315, LÅG-2)", async () => {
    state.board = board({ placements: [board().placements[0]!, { ...board().placements[1]!, requirementId: "post-sl" }] });
    renderPage();
    await ready();
    // The failing row belongs to 7B; picking 7A hides it from the list but not from the count.
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
    expect(screen.getByText("failingTitle(1)")).toBeInTheDocument();
    expect(screen.getByText("failingHidden(1)")).toBeInTheDocument();
    expect(screen.queryByTestId("failing-row")).not.toBeInTheDocument();
  });
});

describe("the list of posts", () => {
  it("states each post's lessons: placed of all, fixed in the grundschema, left for Generera", async () => {
    renderPage();
    await ready();
    const ma = posts().find((entry) => entry.textContent?.includes("Matematik 7A"))!;
    expect(ma).toHaveTextContent("postFigures(1|3|1|1)");
    // Its rows, each with its day (the key, echoed) and time, its room, its weeks and its verdict.
    const rows = within(ma).getAllByTestId("placement-row");
    expect(rows[0]).toHaveTextContent("2 10:00–11:00 · A12");
    expect(rows[0]).toHaveTextContent("holds");
    expect(rows[1]).toHaveTextContent("4 13:00–14:00 · A12");
    expect(rows[1]).toHaveTextContent("verdict.TEACHER");
  });

  it("says why a post in a parallel block cannot be placed, and the weeks it runs", async () => {
    renderPage();
    await ready();
    const sl = posts().find((entry) => entry.textContent?.includes("Slöjd 7B"))!;
    expect(sl).toHaveTextContent("problem.BLOCK");
  });

  it("names a post by its class and subject, in Swedish order", async () => {
    renderPage();
    await ready();
    expect(posts().map((entry) => entry.querySelector("h3")?.textContent)).toEqual(["Matematik 7A", "Slöjd 7B"]);
  });

  it("marks a part nobody teaches as one that cannot be placed, and lists a shared post's parts one by one (review of #315, LÅG-2)", async () => {
    state.board = board({
      posts: [
        {
          ...board().posts[0]!,
          parts: [
            { teacherId: "anna", minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null },
            { teacherId: null, minutes: 60, count: 1, locked: 0, placed: 0, left: 1, cannotPlace: "NO_TEACHER" },
          ],
        },
      ],
      placements: [],
    });
    renderPage();
    await ready();
    expect(posts()[0]).toHaveTextContent("problem.NO_TEACHER");
    expect(posts()[0]).toHaveTextContent("part(noTeacher|1|60|0|0|1)");
    expect(posts()[0]).toHaveTextContent("part(A. Ek|2|60|0|0|2)");
    // A post with one part and nobody missing lists no parts.
    expect(within(posts()[0]!).getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
  });

  it("says when the post's list was saved last: the NEWEST of its rows (review of #315, LÅG-2)", async () => {
    renderPage();
    await ready();
    const ma = posts().find((entry) => entry.textContent?.includes("Matematik 7A"))!;
    // 08:05 UTC is 09:05 in Stockholm: the later row, not the first.
    expect(ma).toHaveTextContent(/savedAt\(13 nov\.? 09:05\)/);
    expect(ma).not.toHaveTextContent(/savedAt\(13 nov\.? 09:00\)/);
  });
});

describe("the week", () => {
  it("draws the förläggningar at once, and the lessons Generera keeps only for what is picked (review of #315, LÅG-3)", async () => {
    renderPage();
    await ready();
    expect(cardOf(ANNA_ROW)).toBeInTheDocument();
    expect(cardOf(BAD_ROW)).toBeInTheDocument();
    // A school that built its grundschema by hand has all of it "kept": not drawn for everything, and said so.
    expect(document.querySelector("[data-lesson-id='kept:k-1']")).not.toBeInTheDocument();
    expect(screen.getByTestId("placement-kept-hidden")).toHaveTextContent("keptHidden(1)");
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
    const kept = document.querySelector("[data-lesson-id='kept:k-1']")!;
    expect(kept).toHaveTextContent("keptNote");
    expect(kept.querySelector("svg")).toBeInTheDocument();
    expect(screen.queryByTestId("placement-kept-hidden")).not.toBeInTheDocument();
  });

  it("draws to 18:00 whatever it holds: a förläggning's day ends there, and the grid is told so (no strips)", async () => {
    renderPage();
    await ready();
    expect(screen.getByText("17:00")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-lesson-id^='day-end:']")).toHaveLength(0);
  });

  it("draws an empty week for the school that lays, with something to focus in its scrolling box, and says it is empty", async () => {
    state.board = board({ placements: [], kept: [] });
    renderPage();
    await ready();
    expect(screen.getByTestId("placement-week-empty")).toHaveTextContent("weekEmpty");
    expect(screen.getByText("17:00")).toBeInTheDocument();
    // axe's scrollable-region-focusable: a scrolling box that holds no lesson is focusable itself.
    expect(document.querySelector("[tabindex='0'].overflow-x-auto")).toBeInTheDocument();
  });

  it("does not draw an empty week for a reader, who has nothing to drag into it", async () => {
    state.adminProfile = "LASARE";
    state.readOnly = true;
    state.board = board({ placements: [], kept: [] });
    renderPage();
    await ready();
    expect(screen.getByTestId("placement-week-empty")).toHaveTextContent("weekEmpty");
    expect(document.querySelector("[data-lesson-id]")).not.toBeInTheDocument();
    expect(screen.queryByText("17:00")).not.toBeInTheDocument();
  });

  it("opens a card in a dialog with its own words and verdict, and a kept lesson with where it is changed", async () => {
    renderPage();
    await ready();
    await userEvent.click(cardOf(BAD_ROW)!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("card-verdict")).toHaveTextContent("verdict.TEACHER");
    expect(dialog).toHaveTextContent("savedAt");
    // To the post's line in the list, as A1's card detail led there.
    expect(within(dialog).getByRole("link", { name: "toPost" })).toHaveAttribute("href", "#post-post-ma");
    await userEvent.click(within(dialog).getByRole("button", { name: "close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
    await userEvent.click(document.querySelector("[data-lesson-id='kept:k-1']")!);
    const kept = await screen.findByRole("dialog");
    expect(kept).toHaveTextContent("keptLocked");
    // Where it is changed: shown to the profile that writes Schemaläggning.
    expect(within(kept).getByRole("link", { name: "toTimetable" })).toHaveAttribute("href", "/admin/timetable");
    expect(within(kept).getByRole("link", { name: "toTimetable" }).closest("[data-writes]")?.getAttribute("data-writes")).toBe("SCHEMALAGGNING");
  });

  it("draws a class's meals as bands once the class is picked", async () => {
    renderPage();
    await ready();
    expect(screen.queryByText("meal(7A)")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
    expect(screen.getByText("meal(7A)")).toBeInTheDocument();
    // 7B's post is no longer in the list.
    expect(posts()).toHaveLength(1);
  });
});

// Salen blir valfri: a förläggning with no room is a lesson the engine places in a room it chooses at every Generera.
describe("a förläggning with no room", () => {
  const ANY_ROW = "post-ma||60|3|09:00|ALL_WEEKS";
  const anyRoom = (over: Partial<BoardPlacement> = {}): BoardPlacement => ({
    id: "row-any",
    requirementId: "post-ma",
    dayOfWeek: 3,
    startTime: "09:00",
    endTime: "10:00",
    minutes: 60,
    roomId: null,
    roomName: null,
    recurrence: "ALL_WEEKS",
    teacherId: null,
    changedAt: "2026-11-13T08:10:00.000Z",
    verdict: { ok: true },
    ...over,
  });
  const withAnyRoom = (over: Partial<BoardPlacement> = {}) => {
    state.board = board({ placements: [...board().placements, anyRoom(over)] });
  };

  it("says in its line that the engine chooses the room, where the room's name would stand", async () => {
    withAnyRoom();
    renderPage();
    await ready();
    const ma = posts().find((entry) => entry.textContent?.includes("Matematik 7A"))!;
    const rows = within(ma).getAllByTestId("placement-row");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent("3 09:00–10:00 · roomAny");
    expect(rows[2]).toHaveTextContent("holds");
    expect(ma.textContent).not.toMatch(/null|undefined/);
  });

  it("draws its card with the same words in the room's place, and opens it with them", async () => {
    withAnyRoom();
    renderPage();
    await ready();
    const card = cardOf(ANY_ROW)!;
    expect(card).toHaveTextContent("roomAny");
    await userEvent.click(card);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("3 09:00–10:00 · roomAny");
  });

  it("names it in the notice about rows that no longer hold, with the reason the judge gives a pair's half without a room", async () => {
    withAnyRoom({ recurrence: "ODD_WEEKS", verdict: { ok: false, reason: "PAIR_ROOM" } });
    renderPage();
    await ready();
    const item = within(screen.getByText("failingTitle(2)").closest('[role="alert"]') as HTMLElement)
      .getAllByTestId("failing-row")
      .find((entry) => entry.textContent?.includes("PAIR_ROOM"))!;
    expect(item).toHaveTextContent("Matematik 7A, 3 09:00–10:00 · roomAny");
    expect(item).toHaveTextContent("verdict.PAIR_ROOM");
  });

  it("matches no room that is picked, and is there again when none is", async () => {
    withAnyRoom();
    renderPage();
    await ready();
    const ma = () => posts().find((entry) => entry.textContent?.includes("Matematik 7A"))!;
    expect(within(ma()).getAllByTestId("placement-row")).toHaveLength(3);

    await userEvent.click(screen.getByRole("button", { name: /filterRoom/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "A12" }));
    // The two rows in A12 stay; the one the engine places does not stand in A12, in the list or in the week.
    expect(within(ma()).getAllByTestId("placement-row")).toHaveLength(2);
    expect(cardOf(ANY_ROW)).not.toBeInTheDocument();
    expect(cardOf(ANNA_ROW)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "clearFilters" }));
    expect(within(ma()).getAllByTestId("placement-row")).toHaveLength(3);
    expect(cardOf(ANY_ROW)).toBeInTheDocument();
  });

  it("is counted in the year's figures like any other row", async () => {
    withAnyRoom();
    renderPage();
    await ready();
    expect(screen.getByTestId("placement-summary")).toHaveTextContent("summary(3|2)");
  });
});

describe("the link from the dialog", () => {
  it("opens the list on the post it names", async () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/sv/admin/placements?post=post-sl");
    renderPage();
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.activeElement).toBe(document.getElementById("post-post-sl"));
  });

  it("waits for a name list that is slower than the board, then opens the list on the post (review of #315, LÅG-1)", async () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/sv/admin/placements?post=post-sl");
    // The board is in; the people are not, so the list is a skeleton and the post's element is not there yet.
    state.peopleLoading = true;
    const { rerender } = renderPage();
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.getElementById("post-post-sl")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    // The people arrive: the board has not changed, and the post is reached all the same.
    state.peopleLoading = false;
    rerender(tree());
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.activeElement).toBe(document.getElementById("post-post-sl"));
  });
});

describe("the states of the read", () => {
  it("is a skeleton while it loads, and says nothing of the week", () => {
    state.boardMode = "loading";
    renderPage();
    expect(screen.queryByTestId("placement-summary")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).toBeInTheDocument();
  });

  it("says it could not be read, with a way to try again, and no week", async () => {
    state.boardMode = "error";
    renderPage();
    expect(await screen.findByText("loadFailed")).toBeInTheDocument();
    const calls = api.get.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(calls));
    expect(screen.queryByTestId("placement-summary")).not.toBeInTheDocument();
  });

  it("keeps the week it has when a later read fails: the error alone is not the page (review of #315, LÅG-2)", async () => {
    renderPage();
    await ready();
    state.boardMode = "error";
    await client.refetchQueries({ queryKey: ["requirementPlacements"] });
    // The read failed (the cache knows it), and the page has had the time to say so if it were going to.
    await waitFor(() => expect(client.getQueryState(["requirementPlacements", "board", "y1"])?.status).toBe("error"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByTestId("placement-summary")).toBeInTheDocument();
    expect(screen.queryByText("loadFailed")).not.toBeInTheDocument();
  });
});

describe("Att lägga", () => {
  it("is a brick for every lesson left, naming the teacher and the length, grouped under its post; a post in a block has none", async () => {
    renderPage();
    await ready();
    expect(bricks().map((brick) => brick.textContent)).toEqual(["brickText(A. Ek|60)"]);
    expect(bricks()[0]).toHaveAttribute("data-brick", "post-ma|anna|60#1");
    expect(screen.getByTestId("brick-post")).toHaveTextContent("Matematik 7A");
    // The name a screen reader gives it holds the post, the teacher and the length (the visible text is in it).
    expect(screen.getByRole("button", { name: "Matematik 7A, brickText(A. Ek|60)" })).toBe(bricks()[0]);
  });

  it("has one brick per lesson of a post that shares its lessons, each with its teacher", async () => {
    state.board = board({
      posts: [
        {
          ...board().posts[0]!,
          parts: [
            { teacherId: "anna", minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null },
            { teacherId: "bo", minutes: 60, count: 1, locked: 0, placed: 0, left: 1, cannotPlace: null },
          ],
        },
      ],
      placements: [],
    });
    renderPage();
    await ready();
    expect(bricks().map((brick) => brick.textContent)).toEqual(["brickText(A. Ek|60)", "brickText(A. Ek|60)", "brickText(B. Lind|60)"]);
  });

  it("names the administrator who teaches on her brick, and anybody else a post carries (the name is looked up in everybody)", async () => {
    state.board = board({
      posts: [
        {
          ...board().posts[0]!,
          parts: [
            { teacherId: "maja", minutes: 60, count: 1, locked: 0, placed: 0, left: 1, cannotPlace: null },
            { teacherId: "rolf", minutes: 60, count: 1, locked: 0, placed: 0, left: 1, cannotPlace: null },
          ],
        },
      ],
      placements: [],
    });
    renderPage();
    await ready();
    expect(bricks().map((brick) => brick.textContent)).toEqual(["brickText(M. Mark|60)", "brickText(R. Rektor|60)"]);
  });

  it("offers the administrator who teaches in the teacher filter, and not one who does not", async () => {
    const user = userEvent.setup();
    renderPage();
    await ready();
    await user.click(screen.getByRole("button", { name: /filterTeacher/ }));
    expect(await screen.findByText("Anna Ek")).toBeInTheDocument();
    expect(screen.getByText("Maja Mark")).toBeInTheDocument();
    expect(screen.queryByText("Rolf Rektor")).not.toBeInTheDocument();
  });

  it("says that nothing is left when nothing is", async () => {
    state.board = board({ posts: [{ ...board().posts[0]!, parts: [{ teacherId: "anna", minutes: 60, count: 1, locked: 0, placed: 1, left: 0, cannotPlace: null }] }] });
    renderPage();
    await ready();
    expect(screen.getByTestId("bricks-empty")).toHaveTextContent("nothingToLay");
  });

  it("is only for the school that writes Planering: marked for the layout to hide it from the rest, and not offered to a reader at all", async () => {
    renderPage();
    await ready();
    expect(screen.getByTestId("brick-post").closest("[data-writes]")?.getAttribute("data-writes")).toBe("PLANERING");
    expect(screen.getByRole("button", { name: "undo" }).closest("[data-writes]")?.getAttribute("data-writes")).toBe("PLANERING");
  });

  it("is not drawn for a profile that does not write Planering, whose grid takes no pointer to move anything", async () => {
    state.adminProfile = "EXPEDITION";
    renderPage();
    await ready();
    expect(bricks()).toHaveLength(0);
    // The grid is the plain one: a card opens, and nothing is laid or moved (no editable columns to drop on).
    expect(columns()).toHaveLength(0);
    await userEvent.click(cardOf(ANNA_ROW)!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "save" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "remove" })).not.toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("is offered to an administrator whose profile carries no profile, whom the layout reads as the full administrator", async () => {
    state.adminProfile = undefined as unknown as string;
    renderPage();
    await ready();
    expect(bricks()).toHaveLength(1);
  });

  it("is not offered to a reader either, whose keyboard has no way in (Läsbehörighet)", async () => {
    state.adminProfile = "LASARE";
    state.readOnly = true;
    renderPage();
    await ready();
    expect(bricks()).toHaveLength(0);
    expect(columns()).toHaveLength(0);
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await noWrite();
  });

  it("marks the pages it points to for the profile that writes their area (review of #315, LÅG-5)", async () => {
    renderPage();
    await ready();
    expect(screen.getByRole("link", { name: "toRequirements" }).closest("[data-writes]")?.getAttribute("data-writes")).toBe("PLANERING");
    expect(screen.getByRole("link", { name: "toGenerate" }).closest("[data-writes]")?.getAttribute("data-writes")).toBe("SCHEMALAGGNING");
  });
});

describe("laying a lesson: press the brick, then a time", () => {
  it("chooses the brick, shows the row for it, and lays the lesson where the week is pressed, with the post's room and weeks", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await userEvent.click(bricks()[0]!);
    expect(bricks()[0]).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByTestId("lay-row")).toHaveTextContent("layChosen(brickLabel(Matematik 7A|A. Ek|60))");

    fireEvent.click(columns()[2]!, at(3, 13, 30));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = lastPut();
    expect(path).toBe("/api/v1/teaching-requirements/post-ma/placements");
    // The whole list: both rows as they stand (the second odd weeks, its room), and the new one, on top of the key that was read.
    expect(body.baseKey).toBe("k000000000000001");
    expect(body.placements).toEqual([
      { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" },
      { dayOfWeek: 4, startTime: "13:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
      { dayOfWeek: 3, startTime: "13:30", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" },
    ]);
    // Said, with the sentence every save ends in, and the card is there, named by the lesson.
    expect(await screen.findByTestId("placement-status")).toHaveTextContent("placed(Matematik 7A|3 13:30–14:30) fromNextGenerate");
    await waitFor(() => expect(cardOf("post-ma||60|3|13:30|ALL_WEEKS")).toBeInTheDocument());
    // The brick is gone (nothing is left of the post to lay), and so is the row.
    await waitFor(() => expect(bricks()).toHaveLength(0));
    expect(screen.queryByTestId("lay-row")).not.toBeInTheDocument();
  });

  it("leaves the keyboard on the card that was laid", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await userEvent.click(bricks()[0]!);
    await screen.findByTestId("lay-row");
    fireEvent.click(columns()[0]!, at(1, 9));
    await waitFor(() => expect(document.activeElement).toBe(cardOf("post-ma||60|1|09:00|ALL_WEEKS")));
  });

  it("does nothing for a press on the week when no brick is chosen", async () => {
    pinGeometry();
    renderPage();
    await ready();
    fireEvent.click(columns()[1]!, at(2, 14));
    await noWrite();
  });

  it("says that a press outside the school day is outside it, and writes nothing", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await userEvent.click(bricks()[0]!);
    await screen.findByTestId("lay-row");
    // 17:45 for an hour ends after 18:00.
    fireEvent.click(columns()[0]!, at(1, 17, 45));
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("cannotStandThere(outsideDay)");
    await noWrite();
  });

  it("closes the row when the lesson is laid, also when the post has more bricks, and leaves none of them chosen", async () => {
    pinGeometry();
    state.board = board({
      posts: [{ ...board().posts[0]!, parts: [{ teacherId: "anna", minutes: 60, count: 3, locked: 0, placed: 0, left: 3, cannotPlace: null }] }],
      placements: [],
    });
    renderPage();
    await ready();
    await userEvent.click(bricks()[0]!);
    await screen.findByTestId("lay-row");
    fireEvent.click(columns()[3]!, at(4, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("lay-row")).not.toBeInTheDocument());
    // Two bricks are left of the post, and none is pressed.
    await waitFor(() => expect(bricks()).toHaveLength(2));
    expect(bricks().every((brick) => brick.getAttribute("aria-pressed") === "false")).toBe(true);
  });

  it("offers the room the filter picked for a lesson of a post that has none placed there, though the filter hides that post from the list", async () => {
    state.board = board({
      posts: [...board().posts, { ...board().posts[0]!, id: "post-en", subjectId: "s-sl", teacherId: "bo", parts: [{ teacherId: "bo", minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null }], rowsKey: "e3b0c44298fc1c14" }],
    });
    renderPage();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /filterRoom/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Slöjdsalen" }));
    await userEvent.keyboard("{Escape}");
    // The post stands in no room the filter picked, so it is not listed; its lessons are still to lay, and the room is the picked one.
    expect(screen.queryAllByTestId("placement-post").some((entry) => entry.textContent?.includes("Slöjd 7A"))).toBe(false);
    const brick = document.querySelector<HTMLElement>("[data-brick^='post-en|bo|60#']")!;
    await userEvent.click(brick);
    const row = await screen.findByTestId("lay-row");
    await waitFor(() => expect(within(row).getByRole("combobox", { name: "room" })).toHaveValue("r-sl"));
  });

  it("chooses another brick instead, and none when the chosen one is pressed again", async () => {
    state.board = board({
      posts: [{ ...board().posts[0]!, parts: [{ teacherId: "anna", minutes: 60, count: 3, locked: 0, placed: 0, left: 2, cannotPlace: null }] }],
      placements: [],
    });
    renderPage();
    await ready();
    await userEvent.click(bricks()[1]!);
    expect(bricks()[1]).toHaveAttribute("aria-pressed", "true");
    expect(bricks()[0]).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(bricks()[1]!);
    expect(bricks()[1]).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("lay-row")).not.toBeInTheDocument();
  });
});

describe("laying a lesson: pull the brick into the week", () => {
  it("lays the lesson where it is let go, with the post's room and weeks", async () => {
    pinGeometry();
    renderPage();
    await ready();
    fireEvent.pointerDown(bricks()[0]!, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(5, 9, 0) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(5, 9, 15) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(5, 9, 15) });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements.at(-1)).toEqual({ dayOfWeek: 5, startTime: "09:15", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" });
    expect(lastPut()[1].baseKey).toBe("k000000000000001");
  });

  it("does not pull with a finger, which scrolls the list; a tap chooses", async () => {
    pinGeometry();
    renderPage();
    await ready();
    fireEvent.pointerDown(bricks()[0]!, { pointerId: 1, button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(5, 9, 15) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(5, 9, 15) });
    await noWrite();
  });

  it("pulls nothing from a press that does not move: a click chooses, and no drag is left holding the grid", async () => {
    pinGeometry();
    renderPage();
    await ready();
    fireEvent.pointerDown(bricks()[0]!, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 10 });
    // Later pointers over the week, and another button coming up, find no drag to carry out.
    fireEvent.pointerMove(window, { pointerId: 1, ...at(3, 9) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(3, 9) });
    await noWrite();
    expect(document.querySelector("[class*='border-dashed']")).not.toBeInTheDocument();
  });

  it("lays nothing when it is let go outside the week", async () => {
    pinGeometry();
    renderPage();
    await ready();
    fireEvent.pointerDown(bricks()[0]!, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(2, 9) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(2, 9) });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 900, clientY: 900 });
    await noWrite();
  });

  it("says why a drop cannot be, and writes nothing, when the mirror of the judge refuses it (the teacher has a lesson then)", async () => {
    pinGeometry();
    // Anna teaches a lesson Generera keeps on Wednesday at 10:00.
    state.board = board({ kept: [{ ...board().kept[0]!, id: "k-anna", teacherId: "anna", dayOfWeek: 3, startTime: "10:00", endTime: "11:00", studentGroupId: "g-7b", subjectId: "s-sl", roomId: "r-sl" }] });
    renderPage();
    await ready();
    fireEvent.pointerDown(bricks()[0]!, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(3, 10, 15) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(3, 10, 15) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(3, 10, 15) });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("cannotStandThere(verdict.TEACHER(LESSON|7B|Slöjd|3|10:00|11:00))");
    expect(api.put).not.toHaveBeenCalled();
    // The brick is where it was.
    expect(bricks()).toHaveLength(1);
  });

  it("says the gateway's sentence when the gateway refuses what the mirror let through, and leaves the brick where it was", async () => {
    pinGeometry();
    state.refuse = () => new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 2, reason: "ROOM", otherKind: "LESSON", className: "7B", subjectName: "Slöjd", day: 3, start: "13:00", end: "14:00" });
    renderPage();
    await ready();
    fireEvent.pointerDown(bricks()[0]!, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(3, 13, 0) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(3, 13, 0) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(3, 13, 0) });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("cannotStandThere(verdict.ROOM(LESSON|7B|Slöjd|3|13:00|14:00))");
    expect(bricks()).toHaveLength(1);
    expect(cardOf("post-ma||60|3|13:00|ALL_WEEKS")).not.toBeInTheDocument();
  });
});

describe("laying a lesson: with the keyboard", () => {
  it("chooses the brick with Enter, takes a day, a start and a room, and lays it with the button; the row says the verdict in words", async () => {
    renderPage();
    await ready();
    bricks()[0]!.focus();
    await userEvent.keyboard("{Enter}");
    const row = await screen.findByTestId("lay-row");
    // The first field has the keyboard.
    await waitFor(() => expect(document.activeElement).toBe(within(row).getByRole("combobox", { name: "day" })));
    expect(within(row).getByTestId("place-verdict")).toHaveTextContent("free");

    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "day" }), "3");
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "13:15" } });
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "room" }), "");
    await userEvent.click(within(row).getByRole("button", { name: "lay" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    // "Motorn väljer sal": no room is sent as null.
    expect(lastPut()[1].placements.at(-1)).toEqual({ dayOfWeek: 3, startTime: "13:15", minutes: 60, roomId: null, recurrence: "ALL_WEEKS" });
    await waitFor(() => expect(document.activeElement).toBe(cardOf("post-ma||60|3|13:15|ALL_WEEKS")));
  });

  it("offers the room the post's other lessons stand in, and says in words when the time is taken, in the gateway's own sentence", async () => {
    state.board = board({ kept: [{ ...board().kept[0]!, id: "k-anna", teacherId: "anna", dayOfWeek: 1, startTime: "08:00", endTime: "09:00", studentGroupId: "g-7b", subjectId: "s-sl" }] });
    renderPage();
    await ready();
    await userEvent.click(bricks()[0]!);
    const row = await screen.findByTestId("lay-row");
    expect(within(row).getByRole("combobox", { name: "room" })).toHaveValue("r-a12");
    // The fields start at the first free time: Monday 08:00 is Anna's, so Monday 09:00, and it says it is free.
    expect(within(row).getByLabelText("start")).toHaveValue("09:00");
    expect(within(row).getByTestId("place-verdict")).toHaveTextContent("free");
    // A time that is taken is said in the gateway's own words.
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "08:30" } });
    await waitFor(() => expect(within(row).getByTestId("place-verdict")).toHaveTextContent("verdict.TEACHER"));
  });

  it("steps to the next free time", async () => {
    state.board = board({ kept: [{ ...board().kept[0]!, id: "k-anna", teacherId: "anna", dayOfWeek: 1, startTime: "08:00", endTime: "09:00", studentGroupId: "g-7b", subjectId: "s-sl" }] });
    renderPage();
    await ready();
    await userEvent.click(bricks()[0]!);
    const row = await screen.findByTestId("lay-row");
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "08:00" } });
    await userEvent.click(within(row).getByRole("button", { name: "nextFree" }));
    // Monday 08:00 is taken for an hour; the next quarter that is free is 09:00.
    await waitFor(() => expect(within(row).getByLabelText("start")).toHaveValue("09:00"));
    expect(within(row).getByTestId("place-verdict")).toHaveTextContent("free");
  });

  it("says the gateway's sentence under the fields when it refuses, until a field changes", async () => {
    state.refuse = () => new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 2, reason: "LUNCH" });
    renderPage();
    await ready();
    await userEvent.click(bricks()[0]!);
    const row = await screen.findByTestId("lay-row");
    // The fields are a chunk fetched when the brick is chosen: wait for them.
    await userEvent.click(await within(row).findByRole("button", { name: "lay" }));
    await waitFor(() => expect(within(row).getByTestId("place-verdict")).toHaveTextContent("verdict.LUNCH"));
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "09:15" } });
    expect(within(row).getByTestId("place-verdict")).not.toHaveTextContent("verdict.LUNCH");
  });
});

describe("moving and removing a lesson", () => {
  it("moves a card by an arrow key, a quarter of an hour (up: down would be onto the class's meal), and sends every other row as it is; the keyboard stays on the card", async () => {
    renderPage();
    await ready();
    cardOf(ANNA_ROW)!.focus();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 2, startTime: "09:45", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" },
      { dayOfWeek: 4, startTime: "13:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
    ]);
    expect(lastPut()[1].baseKey).toBe("k000000000000001");
    // The row has another id now, and the card another name: the keyboard follows the lesson.
    await waitFor(() => expect(document.activeElement).toBe(cardOf("post-ma||60|2|09:45|ALL_WEEKS")));
    expect(screen.getByTestId("placement-status")).toHaveTextContent("moved(Matematik 7A|2 09:45–10:45) fromNextGenerate");
  });

  it("moves the odd-week half of a pair on its own, with its weeks", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(BAD_ROW)!, { key: "ArrowRight" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" },
      { dayOfWeek: 5, startTime: "13:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
    ]);
  });

  it("moves a lesson of a shared post without losing its teacher: every row of the list names its own", async () => {
    state.board = board({
      posts: [
        {
          ...board().posts[0]!,
          parts: [
            { teacherId: "anna", minutes: 60, count: 1, locked: 0, placed: 1, left: 0, cannotPlace: null },
            { teacherId: "bo", minutes: 60, count: 1, locked: 0, placed: 1, left: 0, cannotPlace: null },
          ],
        },
      ],
      placements: [
        { ...board().placements[0]!, id: "ra", teacherId: "anna" },
        { ...board().placements[0]!, id: "rb", teacherId: "bo", dayOfWeek: 3, startTime: "08:00", endTime: "09:00", roomId: null, roomName: null },
      ],
    });
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf("post-ma|anna|60|2|10:00|ALL_WEEKS")!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 2, startTime: "09:45", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS", teacherId: "anna" },
      { dayOfWeek: 3, startTime: "08:00", minutes: 60, roomId: null, recurrence: "ALL_WEEKS", teacherId: "bo" },
    ]);
  });

  it("moves a card pulled to another time, and never changes its length", async () => {
    pinGeometry();
    renderPage();
    await ready();
    // The card's own top edge: the press lands in its body, not in the resize grip at its foot.
    fireEvent.pointerDown(cardOf(ANNA_ROW)!, { pointerId: 1, button: 0, ...at(2, 10, 10) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(4, 8, 40) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(4, 8, 40) });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements[0]).toMatchObject({ dayOfWeek: 4, minutes: 60 });
  });

  it("does not stretch a card: a drag at its foot is refused with the reason, and nothing is written (the longer lesson would stand free)", async () => {
    pinGeometry();
    renderPage();
    await ready();
    // Thursday's card, which nothing stands beside: its foot pulled down is a longer lesson the week would hold, if lengths were free.
    fireEvent.pointerDown(cardOf(BAD_ROW)!, { pointerId: 1, button: 0, clientX: 56 + 350, clientY: 653 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 56 + 350, clientY: 659 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 56 + 350, clientY: 659 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 56 + 350, clientY: 659 });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("cannotMoveThere(lengthCannotChange)");
    await noWrite();
  });

  it("does not move a lesson Generera keeps, and says where it is changed", async () => {
    renderPage();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
    fireEvent.keyDown(document.querySelector("[data-lesson-id='kept:k-1']")!, { key: "ArrowDown" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("cannotMoveThere(keptCannotMove)");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("changes a card's room and time in its dialog, and the other rows go as they were", async () => {
    renderPage();
    await ready();
    await userEvent.click(cardOf(ANNA_ROW)!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "room" }), "r-sl");
    await userEvent.click(within(dialog).getByRole("button", { name: "save" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-sl", recurrence: "ALL_WEEKS" },
      { dayOfWeek: 4, startTime: "13:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("takes a whole lesson away at once, and it is a brick to lay again", async () => {
    renderPage();
    await ready();
    await userEvent.click(cardOf(ANNA_ROW)!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "remove" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([{ dayOfWeek: 4, startTime: "13:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" }]);
    await waitFor(() => expect(bricks()).toHaveLength(2));
    expect(screen.getByTestId("placement-status")).toHaveTextContent("removed(Matematik 7A) fromNextGenerate");
  });

  it("asks first before it takes a half of a pair away, and takes both halves", async () => {
    state.board = board({
      placements: [
        { ...board().placements[0]!, recurrence: "ODD_WEEKS" },
        { ...board().placements[1]!, recurrence: "EVEN_WEEKS", dayOfWeek: 3, startTime: "09:00", endTime: "10:00", verdict: { ok: true } },
      ],
    });
    renderPage();
    await ready();
    await userEvent.click(cardOf("post-ma||60|2|10:00|ODD_WEEKS")!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "remove" }));
    // Not yet: the question, with both halves named.
    expect(api.put).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("group", { name: "removePairTitle" })).toHaveTextContent("pairConfirm(Matematik 7A|");
    await userEvent.click(within(dialog).getByRole("button", { name: "removePair" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([]);
    expect(screen.getByTestId("placement-status")).toHaveTextContent("removedPair(Matematik 7A)");
  });
});

describe("undo and redo", () => {
  it("writes the list as it was back, on top of the key the last write left, and says what it undid", async () => {
    renderPage();
    await ready();
    expect(screen.getByRole("button", { name: "undo" })).toBeDisabled();
    cardOf(ANNA_ROW)!.focus();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const keyAfterMove = (state.board as PlacementBoard).posts[0]!.rowsKey;
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].baseKey).toBe(keyAfterMove);
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" },
      { dayOfWeek: 4, startTime: "13:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
    ]);
    await waitFor(() => expect(screen.getByTestId("placement-status")).toHaveTextContent("undone(stepMove) fromNextGenerate"));
    // And forward again.
    await userEvent.click(screen.getByRole("button", { name: "redo" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(3));
    expect(lastPut()[1].placements[0]).toMatchObject({ startTime: "09:45" });
  });

  it("cannot be asked for while a write is on its way", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    // The next write does not answer yet.
    api.put.mockImplementationOnce(() => new Promise(() => undefined));
    fireEvent.keyDown(cardOf("post-ma||60|2|09:45|ALL_WEEKS")!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "redo" })).toBeDisabled();
    // And a third change meanwhile is told to wait, and writes nothing.
    fireEvent.keyDown(cardOf("post-ma||60|2|09:45|ALL_WEEKS")!, { key: "ArrowUp" });
    expect(await screen.findByTestId("placement-status")).toHaveTextContent("waitSaving");
    expect(api.put).toHaveBeenCalledTimes(2);
  });

  it("is Ctrl+Z, as in the grundschema", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].placements[0]).toMatchObject({ startTime: "10:00" });
  });

  it("is refused, with a message, when somebody else has written the post since, and the history is thrown away", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    // Somebody else writes the post: the key the gateway holds is no longer ours.
    state.board = { ...(state.board as PlacementBoard), posts: (state.board as PlacementBoard).posts.map((post) => (post.id === "post-ma" ? { ...post, rowsKey: "k999999999999999" } : post)) };
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("stale");
    expect(screen.getByRole("button", { name: "undo" })).toBeDisabled();
    // Nothing was written by the refused step.
    expect((state.board as PlacementBoard).placements.find((row) => row.requirementId === "post-ma")?.startTime).toBe("09:45");
  });

  it("throws the history away when the week is read again and shows a post somebody else has written, and says so", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    state.board = { ...(state.board as PlacementBoard), posts: (state.board as PlacementBoard).posts.map((post) => (post.id === "post-ma" ? { ...post, rowsKey: "k888888888888888" } : post)) };
    await client.refetchQueries({ queryKey: ["requirementPlacements"] });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("staleHistory");
    expect(screen.getByRole("button", { name: "undo" })).toBeDisabled();
  });
});

describe("a row of the post that does not hold stays (review of #326, MEDEL-2)", () => {
  it("names it by name when a change is saved beside it, says the change was made, and leaves the week's banner to say it too", async () => {
    state.carryFailing = true;
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    const message = await screen.findByTestId("placement-message");
    // The change itself, then the row that stays: its weekday, its time and the gateway's reason.
    expect(message).toHaveTextContent("moved(");
    expect(message).toHaveTextContent("stillFailing(1|4 13:00–14:00: verdict.TEACHER");
    expect(screen.getByText("failingTitle(1)")).toBeInTheDocument();
    // What it moved is on the board as moved, and the red row is as red as it was.
    expect(cardOf("post-ma||60|2|09:45|ALL_WEEKS")).toBeInTheDocument();
  });

  it("says nothing of it when every row holds", async () => {
    state.carryFailing = true;
    state.board = board({ placements: [board().placements[0]!] });
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    expect(screen.queryByTestId("placement-message")).not.toBeInTheDocument();
    expect(screen.getByTestId("placement-status")).toHaveTextContent("moved(");
  });

  it("sends the unchanged rows as they were, which is what lets the gateway tell them from the one that changed", async () => {
    state.carryFailing = true;
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [, body] = lastPut();
    expect(body.placements).toContainEqual(expect.objectContaining({ dayOfWeek: 4, startTime: "13:00", minutes: 60, recurrence: "ODD_WEEKS", roomId: "r-a12" }));
    expect(body.placements).toContainEqual(expect.objectContaining({ dayOfWeek: 2, startTime: "09:45" }));
  });
});

describe("a step that a row refuses (review of #326, LÅG-4)", () => {
  it("is said about the row that would not hold, not as 'cannot be placed there': an undo has no there", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    // The list the undo puts back is [Tuesday 10:00, Thursday 13:00] sorted as the gateway answers; it refuses the second.
    state.refuse = () => new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 1, reason: "TEACHER", className: "7B", subjectName: "Slöjd", day: 4, start: "13:00", end: "14:00" });
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    const message = await screen.findByTestId("placement-message");
    expect(message).toHaveTextContent("otherRowRefused(");
    expect(message).toHaveTextContent("verdict.TEACHER");
    expect(message).not.toHaveTextContent("cannotStandThere");
    // Nothing was undone: the step is still there to try again.
    expect(screen.getByRole("button", { name: "undo" })).toBeEnabled();
  });

  it("is said the same for a redo", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "redo" })).toBeEnabled());
    state.refuse = () => new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 0, reason: "TEACHER" });
    await userEvent.click(screen.getByRole("button", { name: "redo" }));
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("otherRowRefused(");
    expect(screen.getByRole("button", { name: "redo" })).toBeEnabled();
  });
});

describe("the history while a write is on its way (review of #326, LÅG-2)", () => {
  it("does not take a read that overtakes the answer of our own quick second write for somebody else's", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());

    // The second write commits at once (the fake gateway holds its rows from this moment) but its answer is held back.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    api.put.mockImplementationOnce(async (path: string, body: { placements: Array<Record<string, unknown>>; baseKey?: string }) => {
      const answer = await fakePut(path, body);
      await held;
      return answer;
    });
    fireEvent.keyDown(cardOf("post-ma||60|2|09:45|ALL_WEEKS")!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    // A read of the week now sees the second write's key, which our history does not know yet.
    await client.refetchQueries({ queryKey: ["requirementPlacements"] });
    // Given the time to be flagged: what the page makes of the week it has read is an effect of the render after the read.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByTestId("placement-message")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "undo" })).toBeDisabled(); // the write is on its way: nothing is undone meanwhile

    release();
    await waitFor(() => expect(screen.getByTestId("placement-status")).toHaveTextContent("moved("));
    // Still no word of somebody else, and both steps can be undone.
    expect(screen.queryByTestId("placement-message")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "undo" })).toBeEnabled();
  });

  it("still says it when somebody else wrote the post while ours were done", async () => {
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    state.board = { ...(state.board as PlacementBoard), posts: (state.board as PlacementBoard).posts.map((post) => (post.id === "post-ma" ? { ...post, rowsKey: "k555555555555555" } : post)) };
    await client.refetchQueries({ queryKey: ["requirementPlacements"] });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("staleHistory");
  });
});

describe("a post somebody else has written", () => {
  it("is refused with its own message, nothing is changed, and the week is read again", async () => {
    renderPage();
    await ready();
    // The gateway holds another key than the one the page read: somebody wrote the post.
    state.board = { ...(state.board as PlacementBoard), posts: (state.board as PlacementBoard).posts.map((post) => (post.id === "post-ma" ? { ...post, rowsKey: "k777777777777777" } : post)) };
    const reads = api.get.mock.calls.length;
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("stale");
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(reads));
    // The card is where it was, and the page now holds the key the gateway has, so the same move is made on top of it.
    expect(cardOf(ANNA_ROW)).toBeInTheDocument();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].baseKey).toBe("k777777777777777");
  });

  it("says about the OTHER row when the gateway names one: a row that no longer holds refuses every change of its post", async () => {
    // Thursday's row (the second of the post's list) does not hold: the gateway names it for a move of Tuesday's.
    state.refuse = () => new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 1, reason: "TEACHER", className: "7B", subjectName: "Slöjd", day: 4, start: "13:00", end: "14:00" });
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("otherRowRefused(4 13:00–14:00|verdict.TEACHER");
    expect(screen.getByTestId("placement-message")).not.toHaveTextContent("cannotMoveThere");
  });

  it("says it about the lesson that was changed when the gateway names that one", async () => {
    state.refuse = () => new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 0, reason: "TEACHER" });
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("cannotStandThere(verdict.TEACHER");
  });

  it("says that Generera is writing, in the dialog's own sentence, when the grundschema is being rewritten", async () => {
    state.refuse = () => new ApiError(409, "busy", "SCHEDULE_BUSY");
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("busy");
    expect(cardOf(ANNA_ROW)).toBeInTheDocument();
  });

  it("says that something went wrong, in the reader's language and not in the gateway's English", async () => {
    state.refuse = () => new ApiError(500, "An unexpected error occurred. Please try again later.");
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("notSaved");
    // The test's translator echoes the key: this is `common.problemServer`.
    expect(screen.getByTestId("placement-message")).toHaveTextContent("problemServer");
    expect(screen.getByTestId("placement-message")).not.toHaveTextContent("unexpected error");
  });

  it("says what the gateway wrote for the reader when it named the case, without hiding what it was", async () => {
    state.refuse = () => new ApiError(500, "Något oväntat hände i sparandet. Försök igen.", "SAVE_FAILED");
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("notSaved");
    expect(screen.getByTestId("placement-message")).toHaveTextContent("Något oväntat hände i sparandet. Försök igen.");
  });
});

describe("a Generera is running", () => {
  const recently = () => new Date(Date.now() - 60_000).toISOString();

  it("says on top that the schedule it writes will not hold what is changed now", async () => {
    state.jobs = [{ id: "j1", status: "RUNNING", createdAt: recently() }];
    renderPage();
    await ready();
    expect(screen.getByTestId("placement-running")).toHaveTextContent("running");
  });

  it("says it for a run that is waiting too, and says nothing for runs that are done or long lost", async () => {
    state.jobs = [{ id: "j1", status: "PENDING", createdAt: recently() }];
    const { unmount } = renderPage();
    await ready();
    expect(screen.getByTestId("placement-running")).toBeInTheDocument();
    unmount();
    state.jobs = [
      { id: "j2", status: "SUCCEEDED", createdAt: recently() },
      { id: "j3", status: "RUNNING", createdAt: new Date(Date.now() - 16 * 60_000).toISOString() },
    ];
    client.clear();
    renderPage();
    await ready();
    expect(screen.queryByTestId("placement-running")).not.toBeInTheDocument();
  });
});

let release_: () => void = () => undefined;

describe("until the drag tools are here (review of #341, MEDEL-1)", () => {
  const hold = () => {
    let release: () => void = () => undefined;
    tools.gate = new Promise<void>((resolve) => (release = resolve));
    return release;
  };

  it("offers no fields for a chosen brick, lays nothing for a press on the week, and says why; then the fields come with the post's room", async () => {
    pinGeometry();
    const release = hold();
    renderPage();
    await ready();
    await userEvent.click(bricks()[0]!);
    // Without the mirror the fields would say "free" for any time and offer no room: they wait.
    expect(bricks()[0]).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("lay-row")).not.toBeInTheDocument();
    fireEvent.click(columns()[2]!, at(3, 13, 30));
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("toolsLoading");
    await noWrite();
    release();
    const row = await screen.findByTestId("lay-row");
    await waitFor(() => expect(within(row).getByRole("combobox", { name: "room" })).toHaveValue("r-a12"));
    fireEvent.click(columns()[2]!, at(3, 13, 30));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements.at(-1)).toMatchObject({ dayOfWeek: 3, startTime: "13:30", roomId: "r-a12" });
  });

  it("moves no card with an arrow key, and says why, and does not take a kept lesson for one that may be moved", async () => {
    release_ = hold();
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("toolsLoading");
    await noWrite();
    release_();
    await waitFor(() => expect(document.querySelector("[data-lesson-id]")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 30));
    fireEvent.keyDown(cardOf(ANNA_ROW)!, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
  });

  it("keeps a card's dialog read-only, so that it does not say a time is free before the mirror can know", async () => {
    release_ = hold();
    renderPage();
    await ready();
    await userEvent.click(cardOf(ANNA_ROW)!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "save" })).not.toBeInTheDocument();
    release_();
  });

  it("says in words that the tools could not be fetched, and leaves the controls off, when the chunk does not come", async () => {
    pinGeometry();
    tools.failDragTools = true;
    renderPage();
    await ready();
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("toolsFailed");
    await userEvent.click(bricks()[0]!);
    expect(screen.queryByTestId("lay-row")).not.toBeInTheDocument();
    fireEvent.click(columns()[2]!, at(3, 13, 30));
    await noWrite();
  });

  it("fetches the drag tools for a writer and not for a reader, who drags, lays and holds nothing (review of #341, LÅG-5)", async () => {
    const dragToolsFetched = () => tools.fetched.some((load) => load.includes("placement-drag-tools"));
    const weekToolsFetched = () => tools.fetched.some((load) => load.includes("placement-week-tools"));
    hold();
    const writer = renderPage();
    await ready();
    expect(dragToolsFetched()).toBe(true);
    writer.unmount();

    tools.fetched.length = 0;
    state.adminProfile = "REKTOR";
    state.readOnly = true;
    renderPage();
    await ready();
    // The week picker and the cards' week marks are the reader's too.
    expect(weekToolsFetched()).toBe(true);
    expect(dragToolsFetched()).toBe(false);
  });

  it("asks nothing of a reader, who has no controls: the same page, with no message", async () => {
    state.adminProfile = "REKTOR";
    state.readOnly = true;
    hold();
    renderPage();
    await ready();
    expect(screen.queryByTestId("placement-message")).not.toBeInTheDocument();
  });
});
