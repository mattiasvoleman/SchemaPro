import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { BoardPlacement, PlacementBoard } from "@/lib/placement-board";
import PlacementsPage from "./page";

/**
 * Förlägg i veckan, D2: a PAIR laid half by half, and the week picked. The gateway's own rules (PAIRS, PAIR_ROOM, TEACHER_PAIRS) are
 * its specs' and the real database's; here the page is held to what it does with a half that exists nowhere but in it:
 *
 *   - the first half is held, drawn dashed and saying it is not saved, and NOTHING is written until the second is laid;
 *   - the second half writes BOTH in one PUT, the post's whole list with two rows added, on top of the key that was read;
 *   - what becomes of a half held (lib/placement-pair.ts fateOf): leaving, another year, undo, a 409, a refusal, a part with nothing
 *     left, a filter, and another brick;
 *   - the held half is in the way of what is laid beside it;
 *   - a week picked shows only what runs that week, under its dates, in a läsår that starts on a Saturday.
 *
 * Keys are echoed with their values, as the other page tests do.
 */

const state = vi.hoisted(() => ({
  board: undefined as unknown,
  year: { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true } as unknown,
  refuse: null as null | ((path: string, body: { placements: unknown[]; baseKey?: string }) => unknown),
  keyCount: 0,
  rowCount: 0,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({ year: state.year, active: state.year, successor: null, choose: vi.fn(), rosters: null, rostersFailed: false }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { adminProfile: "SCHEMALAGGARE" } }),
  useReadOnly: () => false,
}));
vi.mock("@/lib/queries", () => ({
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-7b", academicYearId: "y1", name: "7B", kind: "CLASS", gradeLevel: 7 },
    ],
    isLoading: false,
  }),
  useSubjects: () => ({
    data: [
      { id: "s-ma", name: "Matematik", color: "#2563eb" },
      { id: "s-sl", name: "Slöjd", color: null },
      { id: "s-fy", name: "Fysik", color: null },
    ],
    isLoading: false,
  }),
  useRooms: () => ({ data: [{ id: "r-a12", name: "A12" }, { id: "r-b3", name: "B3" }], isLoading: false }),
  usePeople: () => ({
    data: [
      { id: "anna", role: "TEACHER", firstName: "Anna", lastName: "Ek", isActive: true },
      { id: "bo", role: "TEACHER", firstName: "Bo", lastName: "Lind", isActive: true },
    ],
    isLoading: false,
  }),
  useConstraints: () => ({ data: [] }),
  useFrameTimes: () => ({ data: [] }),
  useGroupMemberships: () => ({ data: [] }),
  useRoomPreferences: () => ({ data: [] }),
  useOptimizationHistory: () => ({ data: [] }),
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

const HELD = "[data-lesson-id='pairhalf:post-ma|anna|60']";
const cardOf = (key: string) => document.querySelector<HTMLElement>(`[data-lesson-id='placement:${key}']`);
const held = () => document.querySelector<HTMLElement>(HELD);

const post = (over: Record<string, unknown> = {}) => ({
  studentGroupId: "g-7a",
  subjectId: "s-ma",
  teacherId: "anna",
  coTeacherId: null,
  recurrence: "ALL_WEEKS" as const,
  startDate: null,
  endDate: null,
  cannotPlace: null,
  ...over,
});
const part = (over: Record<string, unknown> = {}) => ({ teacherId: "anna", minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null, ...over });

const baseBoard = (): PlacementBoard =>
  ({
    academicYearId: "y1",
    posts: [
      // Matematik 7A: two lessons of 60 minutes to lay, every week: a post that can be a pair.
      { ...post(), id: "post-ma", parts: [part()], rowsKey: "k000000000000001" },
      // Slöjd 7B shares its lessons: Bo has one, Anna one.
      { ...post({ studentGroupId: "g-7b", subjectId: "s-sl", teacherId: "bo" }), id: "post-sl", parts: [part({ teacherId: "bo", count: 1, left: 1 }), part({ teacherId: "anna", count: 1, left: 1 })], rowsKey: "k000000000000002" },
      // Fysik 7A runs odd weeks only: it has no other half.
      { ...post({ subjectId: "s-fy", recurrence: "ODD_WEEKS" }), id: "post-fy", parts: [part({ count: 1, left: 1 })], rowsKey: "k000000000000003" },
    ],
    placements: [],
    kept: [],
    meals: [],
    blocks: [],
  }) as unknown as PlacementBoard;

/** The fake PUT: the post's list replaced with new ids and a new key, `baseKey` checked; a pair of halves is ONE lesson, a lone half none. */
function fakePut(path: string, body: { placements: Array<Record<string, unknown>>; baseKey?: string }) {
  if (state.refuse) {
    const answer = state.refuse(path, body);
    if (answer !== undefined) return Promise.reject(answer);
  }
  const current = state.board as PlacementBoard;
  const postId = /teaching-requirements\/([^/]+)\/placements/.exec(path)![1]!;
  const entry = current.posts.find((candidate) => candidate.id === postId)!;
  if (body.baseKey !== undefined && body.baseKey !== entry.rowsKey) return Promise.reject(new ApiError(409, "stale", "REQUIREMENT_PLACEMENTS_STALE", { requirementId: postId }));
  const rowsKey = `k9${String(++state.keyCount).padStart(14, "0")}`;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const written = body.placements.map((input) => {
    const start = Number(String(input["startTime"]).slice(0, 2)) * 60 + Number(String(input["startTime"]).slice(3, 5));
    const roomId = (input["roomId"] as string | null | undefined) ?? null;
    return {
      id: `n-${++state.rowCount}`,
      requirementId: postId,
      dayOfWeek: input["dayOfWeek"] as number,
      startTime: String(input["startTime"]),
      endTime: clock(start + Number(input["minutes"])),
      minutes: input["minutes"] as number,
      roomId,
      roomName: roomId === "r-a12" ? "A12" : roomId === "r-b3" ? "B3" : null,
      recurrence: input["recurrence"] as BoardPlacement["recurrence"],
      teacherId: (input["teacherId"] as string | undefined) ?? null,
    };
  });
  const whole = written.filter((row) => row.recurrence === "ALL_WEEKS").length;
  const odd = written.filter((row) => row.recurrence === "ODD_WEEKS").length;
  const even = written.filter((row) => row.recurrence === "EVEN_WEEKS").length;
  const placed = whole + Math.min(odd, even);
  state.board = {
    ...current,
    placements: [...current.placements.filter((row) => row.requirementId !== postId), ...written.map((row) => ({ ...row, changedAt: "2026-11-16T09:00:00.000Z", verdict: { ok: true } }))],
    posts: current.posts.map((candidate) =>
      candidate.id === postId ? { ...candidate, rowsKey, parts: candidate.parts.map((p, index) => (index === 0 ? { ...p, placed, left: Math.max(0, p.count - p.locked - placed) } : p)) } : candidate,
    ),
  };
  return Promise.resolve({ placements: written, verdicts: written.map((_, index) => ({ index, ok: true })), rowsKey });
}

let client: QueryClient;
const tree = () => (
  <QueryClientProvider client={client}>
    <PlacementsPage />
  </QueryClientProvider>
);

beforeEach(() => {
  state.board = baseBoard();
  state.year = { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true };
  state.refuse = null;
  state.keyCount = 0;
  state.rowCount = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset().mockImplementation(async () => structuredClone(state.board));
  api.put.mockReset().mockImplementation(fakePut);
  window.history.replaceState(null, "", "/sv/admin/placements");
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** jsdom has no layout: 56 px of time axis and five columns of 100 px, 08:00 to 18:00 at 1.1 px a minute (the other page tests pin the same). */
const RECT = { x: 0, y: 0, top: 0, left: 0, right: 556, bottom: 660, width: 556, height: 660, toJSON: () => ({}) } as DOMRect;
const pinGeometry = () => vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
const at = (day: number, hour: number, minute = 0) => ({ clientX: 56 + (day - 1) * 100 + 50, clientY: Math.round((hour * 60 + minute - 480) * 1.1) });
const columns = () => Array.from(document.querySelectorAll<HTMLElement>("[data-writes-inert='SCHEMALAGGNING DRIFT']"));
const bricks = () => Array.from(document.querySelectorAll<HTMLElement>("[data-brick]"));
const brickOf = (key: string) => document.querySelector<HTMLElement>(`[data-brick='${key}']`)!;
const status = () => screen.getByTestId("placement-status");
const message = () => screen.queryByTestId("placement-message");
const lastPut = () => api.put.mock.calls.at(-1) as [string, { placements: Array<Record<string, unknown>>; baseKey?: string }];
const noWrite = async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(api.put).not.toHaveBeenCalled();
};
const ready = async () => {
  await screen.findByTestId("placement-summary");
};
const renderPage = () => render(tree());

/** The brick chosen and the row for it open, with the weeks it is laid for picked. */
async function chooseBrick(key: string, weeks?: "ODD_WEEKS" | "EVEN_WEEKS") {
  await userEvent.click(brickOf(key));
  const row = await screen.findByTestId("lay-row");
  if (weeks) {
    const fields = await screen.findByTestId("pair-fields");
    await userEvent.selectOptions(within(fields).getByRole("combobox"), weeks);
  }
  return row;
}
const setRoom = async (room: string) => userEvent.selectOptions(within(screen.getByTestId("lay-row")).getByRole("combobox", { name: "room" }), room);

/** The first half held: Matematik 7A, odd weeks first, Tuesday 10:00 in A12, laid by pressing the week. */
async function holdFirstHalf(weeks: "ODD_WEEKS" | "EVEN_WEEKS" = "ODD_WEEKS") {
  await chooseBrick("post-ma|anna|60#1", weeks);
  await setRoom("r-a12");
  fireEvent.click(columns()[1]!, at(2, 10));
  await waitFor(() => expect(held()).toBeInTheDocument());
}

describe("a pair is offered for a post of every week and for no other", () => {
  it("shows the weeks choice for the chosen brick of an every-week post, with every week as the default", async () => {
    renderPage();
    await ready();
    await chooseBrick("post-ma|anna|60#1");
    const fields = await screen.findByTestId("pair-fields");
    expect(within(fields).getByRole("combobox")).toHaveValue("ALL_WEEKS");
    // The lay row is as it was: the button says "lay", and the room may be left to the engine.
    expect(within(screen.getByTestId("lay-row")).getByRole("button", { name: "lay" })).toBeEnabled();
  });

  it("offers none for a post of odd weeks, which has no other half", async () => {
    renderPage();
    await ready();
    await userEvent.click(brickOf("post-fy|anna|60#1"));
    await screen.findByTestId("lay-row");
    expect(screen.queryByTestId("pair-fields")).not.toBeInTheDocument();
  });

  it("lays the brick every week as always when the choice is left alone", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await chooseBrick("post-ma|anna|60#1");
    fireEvent.click(columns()[2]!, at(3, 13, 30));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([{ dayOfWeek: 3, startTime: "13:30", minutes: 60, roomId: null, recurrence: "ALL_WEEKS" }]);
  });
});

describe("laying the first half", () => {
  it("holds it in the page and writes nothing: the card is dashed, says that it is not saved, and the row says what is held and what to do", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    await noWrite();
    const card = held()!;
    expect(card).toHaveTextContent("heldNote(weeksOdd)");
    // The grid's own mark for something that is not in force: a dashed outline.
    expect(card.className).toContain("outline-dashed");
    const body = within(screen.getByTestId("pair-held"));
    expect(body.getByText("heldTitle")).toBeInTheDocument();
    expect(body.getByText(/^heldBody\(Matematik 7A\|weeksOdd\|weeksEven\|/)).toBeInTheDocument();
    expect(status()).toHaveTextContent("firstHeld(weeksOdd|weeksEven|");
    // The brick is still there (nothing is written, so nothing is laid), and the row now lays the second half.
    expect(brickOf("post-ma|anna|60#1")).toBeInTheDocument();
    // The row now lays the second half, with the first half's room as its own (the fields start from it).
    expect(within(screen.getByTestId("lay-row")).getByRole("button", { name: "laySecond" })).toBeEnabled();
    expect(within(screen.getByTestId("lay-row")).getByRole("combobox", { name: "room" })).toHaveValue("r-a12");
  });

  it("asks for a room on a half: no room, no half, and no write", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await chooseBrick("post-ma|anna|60#1", "ODD_WEEKS");
    // The fields say it, and the button waits; a press on the week says it too.
    expect(within(screen.getByTestId("lay-row")).getByTestId("place-verdict")).toHaveTextContent("pair.needsRoom");
    expect(within(screen.getByTestId("lay-row")).getByRole("button", { name: "layFirst" })).toBeDisabled();
    fireEvent.click(columns()[1]!, at(2, 10));
    await waitFor(() => expect(message()).toHaveTextContent("needsRoom"));
    expect(held()).toBeNull();
    await noWrite();
  });

  it("holds a half laid by pulling the brick into the week, with the room the fields hold", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await chooseBrick("post-ma|anna|60#1", "EVEN_WEEKS");
    await setRoom("r-b3");
    fireEvent.pointerDown(brickOf("post-ma|anna|60#1"), { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(4, 9, 0) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(4, 9, 15) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(4, 9, 15) });
    await waitFor(() => expect(held()).toBeInTheDocument());
    expect(held()).toHaveTextContent("heldNote(weeksEven)");
    expect(held()).toHaveTextContent("B3");
    await noWrite();
  });

  it("holds a half laid with the keyboard alone: the weeks, a day, a start and a room, and the button", async () => {
    renderPage();
    await ready();
    brickOf("post-ma|anna|60#1").focus();
    await userEvent.keyboard("{Enter}");
    const fields = await screen.findByTestId("pair-fields");
    await userEvent.selectOptions(within(fields).getByRole("combobox"), "ODD_WEEKS");
    const row = screen.getByTestId("lay-row");
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "day" }), "3");
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "13:15" } });
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "room" }), "r-a12");
    await userEvent.click(within(row).getByRole("button", { name: "layFirst" }));
    await waitFor(() => expect(held()).toBeInTheDocument());
    await noWrite();
    // The fields are the second half's now, and the keyboard goes to their first field.
    const second = screen.getByTestId("lay-row");
    await waitFor(() => expect(document.activeElement).toBe(within(second).getByRole("combobox", { name: "day" })));
    // The same room is offered for the second half.
    expect(within(second).getByRole("combobox", { name: "room" })).toHaveValue("r-a12");
  });

  it("is refused by the mirror before it is held when something is in its way", async () => {
    pinGeometry();
    // Anna has a lesson on Tuesday 10:00 that Generera keeps, every week: the odd half cannot stand there.
    state.board = {
      ...baseBoard(),
      kept: [{ id: "k-1", dayOfWeek: 2, startTime: "10:00", endTime: "11:00", studentGroupId: "g-7b", extraGroupIds: [], subjectId: "s-sl", teacherId: "anna", coTeacherId: null, roomId: null, recurrence: "ALL_WEEKS", startDate: null, endDate: null, locked: true, generated: false }],
    };
    renderPage();
    await ready();
    await chooseBrick("post-ma|anna|60#1", "ODD_WEEKS");
    await setRoom("r-a12");
    // The kept lessons are drawn for what is picked only; the mirror holds them whatever is drawn.
    fireEvent.click(columns()[1]!, at(2, 10));
    await waitFor(() => expect(message()).toHaveTextContent("cannotStandThere(verdict.TEACHER"));
    expect(held()).toBeNull();
  });
});

describe("laying the second half writes the pair in one statement", () => {
  it("sends the post's whole list with both rows, on the key that was read, and leaves the keyboard on the second card", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    // The picked room stays for the second half (the fields start from it); press Thursday 13:15.
    fireEvent.click(columns()[3]!, at(4, 13, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = lastPut();
    expect(path).toBe("/api/v1/teaching-requirements/post-ma/placements");
    expect(body.baseKey).toBe("k000000000000001");
    expect(body.placements).toEqual([
      { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
      { dayOfWeek: 4, startTime: "13:15", minutes: 60, roomId: "r-a12", recurrence: "EVEN_WEEKS" },
    ]);
    // Said as a pair, the half is gone, and so are the held card and the row's held block.
    await waitFor(() => expect(status()).toHaveTextContent("placedPair(Matematik 7A|"));
    expect(status()).toHaveTextContent("fromNextGenerate");
    expect(held()).toBeNull();
    await waitFor(() => expect(cardOf("post-ma||60|4|13:15|EVEN_WEEKS")).toBeInTheDocument());
    expect(cardOf("post-ma||60|2|10:00|ODD_WEEKS")).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(cardOf("post-ma||60|4|13:15|EVEN_WEEKS")));
    // One lesson placed, one left: one brick is gone, the other is still there, and the choice is every week again.
    // Matematik 7A has one lesson left, Slöjd 7B two (Bo's and Anna's), Fysik 7A one.
    await waitFor(() => expect(bricks()).toHaveLength(4));
    expect(brickOf("post-ma|anna|60#1")).toBeInTheDocument();
    expect(screen.queryByTestId("pair-held")).not.toBeInTheDocument();
  });

  it("starts with the even weeks when that is what was chosen, and the rows say so in that order", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf("EVEN_WEEKS");
    fireEvent.click(columns()[3]!, at(4, 13, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements.map((row) => row["recurrence"])).toEqual(["EVEN_WEEKS", "ODD_WEEKS"]);
  });

  it("writes a pair laid by pulling the second half into the week, with the room the fields hold", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    await setRoom("r-b3");
    fireEvent.pointerDown(brickOf("post-ma|anna|60#1"), { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(5, 9, 0) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(5, 9, 15) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(5, 9, 15) });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
      { dayOfWeek: 5, startTime: "09:15", minutes: 60, roomId: "r-b3", recurrence: "EVEN_WEEKS" },
    ]);
  });

  it("writes the pair after the rows the post already has, every one as it stands", async () => {
    pinGeometry();
    state.board = {
      ...baseBoard(),
      placements: [{ id: "row-1", requirementId: "post-ma", dayOfWeek: 1, startTime: "08:00", endTime: "09:00", minutes: 60, roomId: "r-b3", roomName: "B3", recurrence: "ALL_WEEKS", teacherId: null, changedAt: "2026-11-13T08:00:00.000Z", verdict: { ok: true } }],
      posts: baseBoard().posts.map((entry) => (entry.id === "post-ma" ? { ...entry, parts: [part({ placed: 1, left: 1 })] } : entry)),
    };
    renderPage();
    await ready();
    await holdFirstHalf();
    fireEvent.click(columns()[3]!, at(4, 13, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 1, startTime: "08:00", minutes: 60, roomId: "r-b3", recurrence: "ALL_WEEKS" },
      { dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ODD_WEEKS" },
      { dayOfWeek: 4, startTime: "13:15", minutes: 60, roomId: "r-a12", recurrence: "EVEN_WEEKS" },
    ]);
  });

  it("names one teacher on both halves of a shared post's pair, the teacher whose lesson the brick is", async () => {
    pinGeometry();
    renderPage();
    await ready();
    // Slöjd 7B: Bo's brick and Anna's are two lessons; the pair is Bo's.
    await userEvent.click(brickOf("post-sl|bo|60#1"));
    await screen.findByTestId("lay-row");
    const fields = await screen.findByTestId("pair-fields");
    await userEvent.selectOptions(within(fields).getByRole("combobox"), "ODD_WEEKS");
    await setRoom("r-b3");
    fireEvent.click(columns()[0]!, at(1, 9));
    await waitFor(() => expect(document.querySelector("[data-lesson-id='pairhalf:post-sl|bo|60']")).toBeInTheDocument());
    fireEvent.click(columns()[2]!, at(3, 9));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[0]).toBe("/api/v1/teaching-requirements/post-sl/placements");
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 1, startTime: "09:00", minutes: 60, roomId: "r-b3", recurrence: "ODD_WEEKS", teacherId: "bo" },
      { dayOfWeek: 3, startTime: "09:00", minutes: 60, roomId: "r-b3", recurrence: "EVEN_WEEKS", teacherId: "bo" },
    ]);
    // Anna's lesson of the post is still to lay.
    await waitFor(() => expect(brickOf("post-sl|anna|60#1")).toBeInTheDocument());
  });
});

describe("what becomes of a half that is held (BESLUT, lib/placement-pair.ts)", () => {
  it("lets it go with the button, writes nothing and says so", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    await userEvent.click(within(screen.getByTestId("pair-held")).getByRole("button", { name: "release" }));
    await waitFor(() => expect(held()).toBeNull());
    expect(status()).toHaveTextContent("released");
    await noWrite();
  });

  it("takes it back first on undo, before any step that was written, and writes nothing", async () => {
    pinGeometry();
    renderPage();
    await ready();
    // One step written first: a whole lesson.
    await chooseBrick("post-ma|anna|60#1");
    fireEvent.click(columns()[2]!, at(3, 13, 30));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    await holdFirstHalf();
    expect(screen.getByRole("button", { name: "undo" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    await waitFor(() => expect(held()).toBeNull());
    expect(status()).toHaveTextContent("undoneHalf");
    // Not the written step: it is still there, and nothing more was written.
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(cardOf("post-ma||60|3|13:30|ALL_WEEKS")).toBeInTheDocument();
    // The next undo is the written step's.
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
  });

  it("takes it back on Ctrl+Z too, and the undo button is enabled for it when nothing is written yet", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    expect(screen.getByRole("button", { name: "undo" })).toBeEnabled();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(held()).toBeNull());
    await noWrite();
  });

  it("does not bring a half back on redo: a half is not a step", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    await waitFor(() => expect(held()).toBeNull());
    expect(screen.getByRole("button", { name: "redo" })).toBeDisabled();
  });

  it("lets it go when another läsår is chosen, and says so", async () => {
    pinGeometry();
    const { rerender } = renderPage();
    await ready();
    await holdFirstHalf();
    state.year = { id: "y2", name: "2027/28", startDate: "2027-08-14", endDate: "2028-06-10", isActive: false };
    rerender(tree());
    await waitFor(() => expect(status()).toHaveTextContent("releasedYear"));
    // The other year's week is drawn (its board has been read): the half is not back, and the row for it is gone.
    await ready();
    expect(held()).toBeNull();
    expect(screen.queryByTestId("pair-held")).not.toBeInTheDocument();
    expect(screen.queryByTestId("lay-row")).not.toBeInTheDocument();
    await noWrite();
  });

  it("keeps it on a 409 (STALE): nothing is written, the week is read again and the SECOND half is the one that is laid again", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    state.refuse = () => new ApiError(409, "stale", "REQUIREMENT_PLACEMENTS_STALE", { requirementId: "post-ma" });
    const reads = api.get.mock.calls.length;
    fireEvent.click(columns()[3]!, at(4, 13, 15));
    await waitFor(() => expect(message()).toHaveTextContent("staleKept"));
    expect(api.put).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(reads));
    expect(held()).toBeInTheDocument();
    expect(screen.getByTestId("pair-held")).toBeInTheDocument();
    // Laid again once the week is as it was: written, both rows.
    state.refuse = null;
    fireEvent.click(columns()[3]!, at(4, 13, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].placements).toHaveLength(2);
    await waitFor(() => expect(held()).toBeNull());
  });

  it("keeps it when the pair is refused for a clash, and says which half and why: the sentence is about the pair", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    // The gateway names the row by its place in the list that was SENT: the held half is the first.
    state.refuse = () => new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 0, reason: "LUNCH" });
    fireEvent.click(columns()[3]!, at(4, 13, 15));
    await waitFor(() => expect(message()).toHaveTextContent("cannotPair("));
    expect(message()).toHaveTextContent("verdict.LUNCH");
    expect(held()).toBeInTheDocument();
    // The second half is refused likewise (index 1): a refusal of either half is the pair's.
    state.refuse = () => new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 1, reason: "ROOM" });
    fireEvent.click(columns()[3]!, at(4, 14, 30));
    await waitFor(() => expect(message()).toHaveTextContent("verdict.ROOM"));
    expect(message()).toHaveTextContent("cannotPair(");
    expect(held()).toBeInTheDocument();
  });

  it("lets it go when the part has no lesson left to lay on the week as it is read again, and says so", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    // Somebody else laid both lessons of the post.
    state.board = { ...baseBoard(), posts: baseBoard().posts.map((entry) => (entry.id === "post-ma" ? { ...entry, rowsKey: "kffffffffffffff1", parts: [part({ placed: 2, left: 0 })] } : entry)) };
    await act(async () => {
      await client.invalidateQueries();
    });
    await waitFor(() => expect(held()).toBeNull());
    expect(message()).toHaveTextContent("releasedGone(Matematik 7A)");
  });

  it("is not lost to a filter: the half and the row for it stay when the post is filtered out of the lists", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7B" }));
    // 7A's bricks are not drawn now, but the half is held and the row can still lay its second half.
    await waitFor(() => expect(brickOf("post-ma|anna|60#1")).toBeNull());
    expect(held()).toBeInTheDocument();
    expect(within(screen.getByTestId("lay-row")).getByRole("button", { name: "laySecond" })).toBeInTheDocument();
    expect(screen.getByTestId("pair-held")).toBeInTheDocument();
  });

  it("does not let another brick be chosen or pulled while a half is held: the half is laid or let go first", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    // With the keyboard (a press of the mouse is also a pull, which says the same): Enter on another brick chooses nothing.
    brickOf("post-fy|anna|60#1").focus();
    await userEvent.keyboard("{Enter}");
    expect(message()).toHaveTextContent("finishFirst");
    expect(brickOf("post-fy|anna|60#1")).toHaveAttribute("aria-pressed", "false");
    // The row is still the half's.
    expect(screen.getByTestId("pair-held")).toBeInTheDocument();
    fireEvent.pointerDown(brickOf("post-fy|anna|60#1"), { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(5, 9, 0) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(5, 9, 15) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(5, 9, 15) });
    await noWrite();
    expect(held()).toBeInTheDocument();
  });

  it("asks before a link inside the app is followed while a half is held, and not when none is", async () => {
    pinGeometry();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await ready();
    const link = screen.getByRole("link", { name: "toGenerate" });
    link.setAttribute("href", "/sv/admin/generate");
    // jsdom does not navigate: what the app's own listener would receive is swallowed here, and counted.
    let reached = 0;
    document.body.addEventListener("click", (event) => {
      // The link's clicks only: the presses on the week bubble to the body too.
      if (!(event.target instanceof Element) || !event.target.closest("a[href='/sv/admin/generate']")) return;
      reached += 1;
      event.preventDefault();
    });
    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();
    expect(reached).toBe(1);
    await holdFirstHalf();
    // A no stops the click before the app's listener.
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(confirm).toHaveBeenCalledWith("leave");
    expect(reached).toBe(1);
  });
});

describe("the held half is in the week's way, and can be moved", () => {
  it("refuses a lesson of the same teacher laid on the same time that the half runs", async () => {
    pinGeometry();
    // A lesson of Anna's, every week, Thursday 10:00, that is a row of another post: movable here.
    state.board = {
      ...baseBoard(),
      placements: [{ id: "row-fy", requirementId: "post-fy", dayOfWeek: 4, startTime: "10:00", endTime: "11:00", minutes: 60, roomId: "r-b3", roomName: "B3", recurrence: "ODD_WEEKS", teacherId: null, changedAt: "2026-11-13T08:00:00.000Z", verdict: { ok: true } }],
      posts: baseBoard().posts.map((entry) => (entry.id === "post-fy" ? { ...entry, parts: [part({ count: 1, placed: 1, left: 0 })] } : entry)),
    };
    renderPage();
    await ready();
    await holdFirstHalf();
    // Anna's odd-weeks Fysik is moved onto Tuesday 10:00, where her odd half of Matematik is held: both odd, both Anna.
    const fysik = cardOf("post-fy||60|4|10:00|ODD_WEEKS")!;
    fireEvent.pointerDown(fysik, { pointerId: 2, button: 0, ...at(4, 10, 5) });
    fireEvent.pointerMove(window, { pointerId: 2, ...at(2, 10, 5) });
    fireEvent.pointerUp(window, { pointerId: 2, ...at(2, 10, 5) });
    await waitFor(() => expect(message()).toHaveTextContent("cannotMoveThere("));
    await noWrite();
  });

  it("lets the even half of the same lesson stand on the same time as the odd one: the weeks never meet", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    // The second half at the very same time: odd and even weeks do not meet, so the mirror holds it free.
    const row = screen.getByTestId("lay-row");
    await waitFor(() => expect(within(row).getByTestId("place-verdict")).toHaveTextContent("free"));
    fireEvent.click(columns()[1]!, at(2, 10));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements.map((entry) => [entry["dayOfWeek"], entry["startTime"], entry["recurrence"]])).toEqual([
      [2, "10:00", "ODD_WEEKS"],
      [2, "10:00", "EVEN_WEEKS"],
    ]);
  });

  it("judges the second half for the OTHER weeks: on the very time and with the very teacher of the held half it is free, and the fields say so", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    // The held odd half stands on Tuesday 10:00. The second half's fields are put on the same Tuesday 10:00: even weeks, so no clash.
    const row = screen.getByTestId("lay-row");
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "day" }), "2");
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "10:00" } });
    await waitFor(() => expect(within(row).getByTestId("place-verdict")).toHaveTextContent("free"));
    // And a lesson of the same weeks (an every-week lesson would be) is not: the mirror knows the half runs the odd weeks.
    expect(within(row).getByTestId("place-verdict")).not.toHaveTextContent("verdict.");
  });

  it("holds the half of a shared post as its own teacher's lesson in the week's way (Anna's half is Anna's, not the post's teacher Bo's)", async () => {
    pinGeometry();
    // Anna's odd-weeks Fysik, Monday 09:00 in B3: moved onto Tuesday 10:00 later, where Anna's half of Slöjd is held.
    state.board = {
      ...baseBoard(),
      placements: [{ id: "row-fy", requirementId: "post-fy", dayOfWeek: 4, startTime: "10:00", endTime: "11:00", minutes: 60, roomId: "r-b3", roomName: "B3", recurrence: "ODD_WEEKS", teacherId: null, changedAt: "2026-11-13T08:00:00.000Z", verdict: { ok: true } }],
      posts: baseBoard().posts.map((entry) => (entry.id === "post-fy" ? { ...entry, parts: [part({ count: 1, placed: 1, left: 0 })] } : entry)),
    };
    renderPage();
    await ready();
    // Slöjd 7B is Bo's post; the lesson that is Anna's is the pair.
    await userEvent.click(brickOf("post-sl|anna|60#1"));
    await screen.findByTestId("lay-row");
    await userEvent.selectOptions(within(await screen.findByTestId("pair-fields")).getByRole("combobox"), "ODD_WEEKS");
    await setRoom("r-a12");
    fireEvent.click(columns()[1]!, at(2, 10));
    await waitFor(() => expect(document.querySelector("[data-lesson-id='pairhalf:post-sl|anna|60']")).toBeInTheDocument());
    await noWrite();
    // Anna's other odd lesson cannot be moved onto the half: the same teacher, the same weeks.
    const fysik = cardOf("post-fy||60|4|10:00|ODD_WEEKS")!;
    fireEvent.pointerDown(fysik, { pointerId: 4, button: 0, ...at(4, 10, 5) });
    fireEvent.pointerMove(window, { pointerId: 4, ...at(2, 10, 5) });
    fireEvent.pointerUp(window, { pointerId: 4, ...at(2, 10, 5) });
    await waitFor(() => expect(message()).toHaveTextContent("cannotMoveThere("));
    await noWrite();
  });

  it("writes a pair that uses the post's last lesson, and says so as a pair: the brick going is not the half being let go", async () => {
    pinGeometry();
    state.board = { ...baseBoard(), posts: baseBoard().posts.map((entry) => (entry.id === "post-ma" ? { ...entry, parts: [part({ count: 1, left: 1 })] } : entry)) };
    renderPage();
    await ready();
    await holdFirstHalf();
    fireEvent.click(columns()[3]!, at(4, 13, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(status()).toHaveTextContent("placedPair(Matematik 7A|"));
    // No word of a half let go, however many renders it took (the count moved with the write, before the half was cleared).
    expect(message()).toBeNull();
    expect(held()).toBeNull();
    await waitFor(() => expect(brickOf("post-ma|anna|60#1")).toBeNull());
    expect(status()).toHaveTextContent("placedPair(Matematik 7A|");
  });

  it("moves the held half by dragging its card, still without writing, and the pair is written where it was left", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await holdFirstHalf();
    fireEvent.pointerDown(held()!, { pointerId: 3, button: 0, ...at(2, 10, 5) });
    fireEvent.pointerMove(window, { pointerId: 3, ...at(3, 10, 5) });
    fireEvent.pointerMove(window, { pointerId: 3, ...at(3, 11, 5) });
    fireEvent.pointerUp(window, { pointerId: 3, ...at(3, 11, 5) });
    await waitFor(() => expect(status()).toHaveTextContent("movedHalf("));
    await noWrite();
    fireEvent.click(columns()[3]!, at(4, 13, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements[0]).toMatchObject({ dayOfWeek: 3, recurrence: "ODD_WEEKS" });
    expect(lastPut()[1].placements[0]!["startTime"]).toMatch(/^11:0[05]$/);
  });
});

/** A board with lessons of every kind of weeks, for the week picked. */
const weeksBoard = (): PlacementBoard => {
  const row = (id: string, requirementId: string, over: Record<string, unknown>) => ({
    id,
    requirementId,
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
    ...over,
  });
  return {
    ...baseBoard(),
    posts: [
      { ...post(), id: "post-ma", parts: [part({ count: 2, placed: 2, left: 0 })], rowsKey: "k000000000000001" },
      { ...post({ studentGroupId: "g-7b", subjectId: "s-sl", teacherId: "bo", endDate: "2026-12-18" }), id: "post-ht", parts: [part({ teacherId: "bo", count: 1, placed: 1, left: 0 })], rowsKey: "k000000000000002" },
      { ...post({ subjectId: "s-fy", startDate: "2027-01-11" }), id: "post-vt", parts: [part({ count: 1, placed: 1, left: 0 })], rowsKey: "k000000000000003" },
    ],
    placements: [
      // Matematik 7A is a pair: odd weeks Tuesday, even weeks Thursday.
      row("r-odd", "post-ma", { recurrence: "ODD_WEEKS", dayOfWeek: 2 }),
      row("r-even", "post-ma", { recurrence: "EVEN_WEEKS", dayOfWeek: 4 }),
      // Slöjd 7B is the autumn's whole (to the 18th of December); Fysik 7A the spring's (from the 11th of January).
      row("r-ht", "post-ht", { teacherId: null, dayOfWeek: 1, startTime: "08:00", endTime: "09:00" }),
      row("r-vt", "post-vt", { dayOfWeek: 3, startTime: "13:00", endTime: "14:00" }),
    ],
  } as unknown as PlacementBoard;
};
const lessonIds = () => Array.from(document.querySelectorAll<HTMLElement>("[data-lesson-id]")).map((element) => element.dataset["lessonId"]!);
const ODD_CARD = "placement:post-ma||60|2|10:00|ODD_WEEKS";
const EVEN_CARD = "placement:post-ma||60|4|10:00|EVEN_WEEKS";
const HT_CARD = "placement:post-ht||60|1|08:00|ALL_WEEKS";
const VT_CARD = "placement:post-vt||60|3|13:00|ALL_WEEKS";
const picker = () => within(screen.getByTestId("week-picker")).getByRole("combobox");

describe("the week picker", () => {
  beforeEach(() => {
    state.board = weeksBoard();
  });

  it("shows every week as the page always has, each card saying its weeks and dates in a mark", async () => {
    renderPage();
    await ready();
    expect(lessonIds().sort()).toEqual([EVEN_CARD, HT_CARD, ODD_CARD, VT_CARD].sort());
    expect(document.querySelector(`[data-lesson-id='${ODD_CARD}']`)).toHaveTextContent("odd");
    expect(document.querySelector(`[data-lesson-id='${EVEN_CARD}']`)).toHaveTextContent("even");
    expect(document.querySelector(`[data-lesson-id='${HT_CARD}']`)).toHaveTextContent("HT");
    expect(document.querySelector(`[data-lesson-id='${VT_CARD}']`)).toHaveTextContent("VT");
    expect(screen.getByTestId("week-picker-status")).toHaveTextContent("shownAll");
  });

  it("starts the weeks of a läsår that begins on a Saturday on the Monday after it, and groups them by term", async () => {
    renderPage();
    await ready();
    const options = within(picker()).getAllByRole("option");
    // "Alla veckor", then the autumn's first week, 34 (Monday the 17th of August): the week that holds the Saturday is not one.
    expect(options[0]).toHaveValue("");
    expect(options[1]).toHaveValue("2026-08-17");
    expect(options[1]).toHaveTextContent("option(34|17 aug.|21 aug.|even)");
    expect(within(picker()).queryByRole("option", { name: /10 aug/ })).not.toBeInTheDocument();
    expect(options.at(-1)).toHaveValue("2027-06-07");
    expect(picker().querySelectorAll("optgroup")).toHaveLength(2);
    // The two odd weeks at the turn of the year: week 53 and week 1.
    expect(within(picker()).getByRole("option", { name: /^option\(53\|/ })).toHaveTextContent("odd");
    expect(within(picker()).getByRole("option", { name: /^option\(1\|/ })).toHaveTextContent("odd");
  });

  it("shows an odd week with the odd lessons and the autumn's, under its dates, and says which week it is", async () => {
    renderPage();
    await ready();
    await userEvent.selectOptions(picker(), "2026-08-24");
    expect(lessonIds().sort()).toEqual([HT_CARD, ODD_CARD].sort());
    expect(screen.getByTestId("week-picker-status")).toHaveTextContent("shown(35|24 aug.|28 aug.|odd)");
    // The dates under the days, from the 24th.
    expect(screen.getAllByText("24/8")).toHaveLength(1);
    expect(screen.getAllByText("28/8")).toHaveLength(1);
  });

  it("shows an even week with the even lessons, and the spring's only from the January it starts in", async () => {
    renderPage();
    await ready();
    await userEvent.selectOptions(picker(), "2026-08-17");
    expect(lessonIds().sort()).toEqual([EVEN_CARD, HT_CARD].sort());
    await userEvent.selectOptions(picker(), "2027-01-11");
    // Week 2 of 2027: even. The autumn's lesson is over; the spring's has begun.
    expect(lessonIds().sort()).toEqual([EVEN_CARD, VT_CARD].sort());
    expect(screen.getAllByText("11/1")).toHaveLength(1);
  });

  it("shows week 53 and week 1 of a year of 53 weeks as the two odd weeks they are: the same odd lessons in both", async () => {
    renderPage();
    await ready();
    await userEvent.selectOptions(picker(), "2026-12-28");
    // Week 53 is after the autumn's last day (the 18th), so the autumn's lesson is not in it.
    expect(lessonIds()).toEqual([ODD_CARD]);
    await userEvent.selectOptions(picker(), "2027-01-04");
    expect(lessonIds()).toEqual([ODD_CARD]);
    await userEvent.selectOptions(picker(), "2027-01-11");
    expect(lessonIds()).not.toContain(ODD_CARD);
  });

  it("steps through the year with the buttons: from every week to the first, then on, and to the last from the first backwards", async () => {
    renderPage();
    await ready();
    const group = screen.getByTestId("week-picker");
    await userEvent.click(within(group).getByRole("button", { name: "next" }));
    expect(picker()).toHaveValue("2026-08-17");
    expect(within(group).getByRole("button", { name: "prev" })).toBeDisabled();
    await userEvent.click(within(group).getByRole("button", { name: "next" }));
    expect(picker()).toHaveValue("2026-08-24");
    await userEvent.selectOptions(picker(), "");
    await userEvent.click(within(group).getByRole("button", { name: "prev" }));
    expect(picker()).toHaveValue("2027-06-07");
    expect(within(group).getByRole("button", { name: "next" })).toBeDisabled();
  });

  it("narrows the cards only: the figures, the lists and the bricks are the year's", async () => {
    state.board = {
      ...weeksBoard(),
      posts: weeksBoard().posts.map((entry) => (entry.id === "post-ma" ? { ...entry, parts: [part({ count: 3, placed: 2, left: 1 })] } : entry)),
    };
    renderPage();
    await ready();
    const summary = screen.getByTestId("placement-summary").textContent;
    const rows = screen.getAllByTestId("placement-row").length;
    await userEvent.selectOptions(picker(), "2026-08-24");
    expect(screen.getByTestId("placement-summary").textContent).toBe(summary);
    expect(screen.getAllByTestId("placement-row")).toHaveLength(rows);
    expect(bricks()).toHaveLength(1);
  });

  it("goes back to every week when the läsår is changed", async () => {
    const { rerender } = renderPage();
    await ready();
    await userEvent.selectOptions(picker(), "2026-08-24");
    state.year = { id: "y2", name: "2027/28", startDate: "2027-08-14", endDate: "2028-06-10", isActive: false };
    rerender(tree());
    await waitFor(() => expect(picker()).toHaveValue(""));
  });

  it("follows the half being laid: the week shown becomes one of the weeks the half runs, and the other's for the second", async () => {
    pinGeometry();
    state.board = baseBoard();
    renderPage();
    await ready();
    // An even week is shown (week 34), and the reader chooses a pair that starts with the odd weeks: the week shown becomes week 35.
    await userEvent.selectOptions(picker(), "2026-08-17");
    await chooseBrick("post-ma|anna|60#1", "ODD_WEEKS");
    expect(picker()).toHaveValue("2026-08-24");
    await setRoom("r-a12");
    fireEvent.click(columns()[1]!, at(2, 10));
    await waitFor(() => expect(held()).toBeInTheDocument());
    // The first half is odd: the second is even, so the week shown follows to an even week (36), and the half is drawn there too.
    await waitFor(() => expect(picker()).toHaveValue("2026-08-31"));
    expect(held()).toBeInTheDocument();
    expect(status()).toHaveTextContent("followed(36|even)");
  });

  it("draws the held half in whatever week is shown: it is in play, not in force", async () => {
    pinGeometry();
    state.board = baseBoard();
    renderPage();
    await ready();
    await holdFirstHalf();
    // Any week of the other parity than the half's, and the half is still on the week.
    await userEvent.selectOptions(picker(), "2026-08-17");
    expect(held()).toBeInTheDocument();
    await userEvent.selectOptions(picker(), "2026-08-24");
    expect(held()).toBeInTheDocument();
  });
});
