import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { BoardBlock, BoardBlockRow, PlacementBoard } from "@/lib/placement-board";
import { placementLinkOf } from "@/lib/placement-link";
import PlacementsPage from "./page";

/**
 * Förlägg i veckan, the PARALLEL BLOCKS (C2). What the gateway counts and judges is its own specs' (block-placements.service.spec.ts); here the page
 * is held to what it makes of the blocks on the board and what it does with a gesture: one brick and one card for a lesson of a block (never one
 * for each post), the three ways of laying it with a room for each post, moving and taking it away, undo, a drop that says WHICH POST clashes and
 * leaves the brick where it was, the gateway's refusals (a lesson that stopped holding, somebody else's write), the figures and the lists, the
 * filters, the readers who see the cards and no bricks, and the link that marks a lesson's card.
 *
 * The gateway is a small fake of the PUT on the block's path (the block's list replaced with new ids, kept in (day, start) order, and a new key;
 * `baseKey` checked), so that the page's own chain of keys and its reading of the answer's indexes are what is tested.
 */

const state = vi.hoisted(() => ({
  board: undefined as unknown,
  adminProfile: "SCHEMALAGGARE" as string | null,
  readOnly: false,
  refuse: null as null | ((path: string, body: { placements: Array<Record<string, unknown>>; baseKey?: string }) => unknown),
  /** A lesson the fake PUT answers with a verdict that does not hold, by its day: the lesson the block already had that stopped holding and was let stand. */
  failingDay: null as null | number,
  keyCount: 0,
  rowCount: 0,
  jobs: [] as Array<{ id: string; status: string; createdAt: string }>,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({ year: { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true }, active: null, successor: null, choose: vi.fn(), rosters: null, rostersFailed: false }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { adminProfile: state.adminProfile } }),
  useReadOnly: () => state.readOnly,
}));
vi.mock("@/lib/queries", () => ({
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-fr", academicYearId: "y1", name: "Fr7", kind: "TEACHING_GROUP", gradeLevel: null },
      { id: "g-sp", academicYearId: "y1", name: "Sp7", kind: "TEACHING_GROUP", gradeLevel: null },
      { id: "g-ty", academicYearId: "y1", name: "Ty7", kind: "TEACHING_GROUP", gradeLevel: null },
    ],
    isLoading: false,
  }),
  useSubjects: () => ({
    data: [
      { id: "s-ma", name: "Matematik", color: "#2563eb" },
      { id: "s-fr", name: "Franska", color: null },
      { id: "s-sp", name: "Spanska", color: null },
      { id: "s-ty", name: "Tyska", color: null },
    ],
    isLoading: false,
  }),
  useRooms: () => ({ data: [{ id: "r-a12", name: "A12" }, { id: "r-ty", name: "Tyska-salen" }], isLoading: false }),
  usePeople: () => ({
    data: ["anna", "t-fr", "t-sp", "t-ty"].map((id) => ({ id, role: "TEACHER", firstName: id.toUpperCase(), lastName: "Lärare", isActive: true })),
    isLoading: false,
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
// The words of the block's own namespace carry it ("block.stale"), so that they are told from the post's words of the same name.
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace?: string) =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) => {
        const name = namespace === "placementWeek.block" ? `block.${key}` : key;
        return values ? `${name}(${Object.values(values).join("|")})` : name;
      },
      { has: () => true },
    ),
}));

const CARD_TUESDAY = "blockplacement:b-sv|60|2|08:00|ALL_WEEKS";
const cardOf = (key: string) => document.querySelector<HTMLElement>(`[data-lesson-id='blockplacement:${key}']`);
const TUESDAY = "b-sv|60|2|08:00|ALL_WEEKS";

const memberPost = (id: string, subject: string, group: string, teacher: string) => ({
  id,
  studentGroupId: group,
  subjectId: subject,
  teacherId: teacher,
  coTeacherId: null,
  recurrence: "ALL_WEEKS" as const,
  startDate: null,
  endDate: null,
  cannotPlace: "BLOCK" as const,
  parts: [{ teacherId: teacher, minutes: 60, count: 2, locked: 0, placed: 1, left: 1, cannotPlace: null }],
  rowsKey: "e3b0c44298fc1c14",
});

const lesson = (over: Partial<BoardBlockRow> = {}): BoardBlockRow => ({
  id: "br-1",
  dayOfWeek: 2,
  startTime: "08:00",
  endTime: "09:00",
  minutes: 60,
  recurrence: "ALL_WEEKS",
  rooms: [{ requirementId: "m-ty", roomId: "r-ty", roomName: "Tyska-salen" }],
  changedAt: "2026-11-13T08:00:00.000Z",
  verdicts: [
    { requirementId: "m-fr", ok: true },
    { requirementId: "m-sp", ok: true },
    { requirementId: "m-ty", ok: true },
  ],
  ...over,
});

const theBlock = (over: Partial<BoardBlock> = {}): BoardBlock => ({
  id: "b-sv",
  name: "Språkval åk 7",
  memberIds: ["m-fr", "m-sp", "m-ty"],
  lengths: [60, 60],
  recurrence: "ALL_WEEKS",
  followsBlockId: null,
  cannotPlace: null,
  rows: [lesson()],
  rowsKey: "bk000000000000001",
  ...over,
});

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
      parts: [{ teacherId: "anna", minutes: 60, count: 2, locked: 0, placed: 0, left: 2, cannotPlace: null }],
      rowsKey: "e3b0c44298fc1c14",
    },
    memberPost("m-fr", "s-fr", "g-fr", "t-fr"),
    memberPost("m-sp", "s-sp", "g-sp", "t-sp"),
    memberPost("m-ty", "s-ty", "g-ty", "t-ty"),
    // A post of a block that follows another: placed through the leader, so no brick.
    { ...memberPost("m-xx", "s-fr", "g-fr", "t-fr"), id: "m-xx" },
  ],
  placements: [],
  kept: [],
  meals: [],
  blocks: [theBlock(), { ...theBlock({ id: "b-follow", name: "Följare", memberIds: ["m-xx"], lengths: [60], rows: [], rowsKey: "e3b0c44298fc1c14" }), cannotPlace: "FOLLOWER", followsBlockId: "b-sv" }],
});

const board = (over: Partial<PlacementBoard> = {}): PlacementBoard => ({ ...baseBoard(), ...over });
const blockOf = (): BoardBlock => (state.board as PlacementBoard).blocks.find((entry) => entry.id === "b-sv")!;

/** The fake PUT of a block: its list replaced with new ids in (day, start) order, a new key, `baseKey` checked, and the board the next read gives is what it left. */
function fakeBlockPut(path: string, body: { placements: Array<Record<string, unknown>>; baseKey?: string }) {
  if (state.refuse) {
    const answer = state.refuse(path, body);
    if (answer !== undefined) return Promise.reject(answer);
  }
  const current = state.board as PlacementBoard;
  const blockId = /teaching-blocks\/([^/]+)\/placements/.exec(path)![1]!;
  const block = current.blocks.find((entry) => entry.id === blockId)!;
  if (body.baseKey !== block.rowsKey) return Promise.reject(new ApiError(409, "stale", "BLOCK_PLACEMENTS_STALE"));
  const rowsKey = `bk${String(++state.keyCount).padStart(14, "0")}9`;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const sorted = [...body.placements].sort(
    (a, b) => (a["dayOfWeek"] as number) - (b["dayOfWeek"] as number) || String(a["startTime"]).localeCompare(String(b["startTime"])),
  );
  const written: BoardBlockRow[] = sorted.map((input) => {
    const start = Number(String(input["startTime"]).slice(0, 2)) * 60 + Number(String(input["startTime"]).slice(3, 5));
    const rooms = (input["rooms"] as Array<{ requirementId: string; roomId: string }>).map((room) => ({ ...room, roomName: room.roomId === "r-ty" ? "Tyska-salen" : "A12" }));
    return {
      id: `bn-${++state.rowCount}`,
      dayOfWeek: input["dayOfWeek"] as number,
      startTime: String(input["startTime"]),
      endTime: clock(start + Number(input["minutes"])),
      minutes: input["minutes"] as number,
      recurrence: "ALL_WEEKS",
      rooms,
      changedAt: "2026-11-16T09:00:00.000Z",
      verdicts: block.memberIds.map((requirementId) => ({ requirementId, ok: true })),
    };
  });
  const verdicts = written.flatMap((row, index) =>
    block.memberIds.map((requirementId) =>
      state.failingDay !== null && row.dayOfWeek === state.failingDay && requirementId === "m-sp"
        ? { index, requirementId, ok: false, reason: "TEACHER", params: { otherKind: "LESSON", className: "7A", subjectName: "Matematik", day: row.dayOfWeek, start: row.startTime, end: row.endTime } }
        : { index, requirementId, ok: true },
    ),
  );
  state.board = {
    ...current,
    blocks: current.blocks.map((entry) => (entry.id === blockId ? { ...entry, rows: written, rowsKey } : entry)),
    posts: current.posts.map((post) =>
      block.memberIds.includes(post.id) ? { ...post, parts: post.parts.map((part) => ({ ...part, placed: written.length, left: Math.max(0, part.count - written.length) })) } : post,
    ),
  };
  return Promise.resolve({
    placements: written.map((row) => ({ id: row.id, blockId, dayOfWeek: row.dayOfWeek, startTime: row.startTime, endTime: row.endTime, minutes: row.minutes, recurrence: row.recurrence, rooms: row.rooms })),
    verdicts,
    rowsKey,
    lengths: block.lengths,
  });
}

let client: QueryClient;
const renderPage = () =>
  render(
    <QueryClientProvider client={client}>
      <PlacementsPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.board = board();
  state.adminProfile = "SCHEMALAGGARE";
  state.readOnly = false;
  state.refuse = null;
  state.failingDay = null;
  state.keyCount = 0;
  state.rowCount = 0;
  state.jobs = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockReset().mockImplementation(async () => structuredClone(state.board));
  api.put.mockReset().mockImplementation(fakeBlockPut);
  window.history.replaceState(null, "", "/sv/admin/placements");
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ready = async () => {
  await screen.findByTestId("placement-summary");
};
const RECT = { x: 0, y: 0, top: 0, left: 0, right: 556, bottom: 660, width: 556, height: 660, toJSON: () => ({}) } as DOMRect;
const pinGeometry = () => vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
const at = (day: number, hour: number, minute = 0) => ({ clientX: 56 + (day - 1) * 100 + 50, clientY: Math.round((hour * 60 + minute - 480) * 1.1) });
const columns = () => Array.from(document.querySelectorAll<HTMLElement>("[data-writes-inert='SCHEMALAGGNING DRIFT']"));
const bricks = () => Array.from(document.querySelectorAll<HTMLElement>("[data-brick]"));
const blockBricks = () => bricks().filter((brick) => brick.dataset["brick"]!.startsWith("block:"));
const noWrite = async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(api.put).not.toHaveBeenCalled();
};
const lastPut = () => api.put.mock.calls.at(-1) as [string, { placements: Array<Record<string, unknown>>; baseKey?: string }];
const pullBlockBrick = (to: { clientX: number; clientY: number }) => {
  fireEvent.pointerDown(blockBricks()[0]!, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(window, { pointerId: 1, ...to });
  fireEvent.pointerMove(window, { pointerId: 1, ...to });
  fireEvent.pointerUp(window, { pointerId: 1, ...to });
};
const TY_ROOM = { requirementId: "m-ty", roomId: "r-ty" };

describe("Att lägga", () => {
  it("is ONE brick for each lesson the block has left, grouped under the block after the posts' bricks, and the posts of the block have none", async () => {
    renderPage();
    await ready();
    // One ordinary post with two lessons left; the block has one of its two lessons left, and its three posts have no brick of their own.
    expect(bricks().map((brick) => brick.dataset["brick"])).toEqual(["post-ma|anna|60#1", "post-ma|anna|60#2", "block:b-sv|60#1"]);
    const group = screen.getByTestId("brick-block");
    expect(group).toHaveTextContent("Språkval åk 7");
    expect(within(group).getByRole("button")).toHaveTextContent("block.brickText(60|3)");
    // A brick's name says the block, the length and the posts, for a screen reader that lands on the brick and not on its heading.
    expect(within(group).getByRole("button")).toHaveAccessibleName("Språkval åk 7, block.brickText(60|3)");
  });

  it("has no brick for a block that cannot be placed, and none for a block whose lessons are all laid", async () => {
    state.board = board({ blocks: [theBlock({ rows: [lesson(), lesson({ id: "br-2", dayOfWeek: 4 })] }), board().blocks[1]!] });
    renderPage();
    await ready();
    expect(blockBricks()).toHaveLength(0);
  });

  it("has a brick for each of a mixed block's lessons that is not laid, per length (80 and 40)", async () => {
    state.board = board({ blocks: [theBlock({ lengths: [80, 40], rows: [lesson({ minutes: 80, endTime: "09:20" })] })] });
    renderPage();
    await ready();
    expect(blockBricks().map((brick) => brick.dataset["brick"])).toEqual(["block:b-sv|40#1"]);
  });

  it("is only for the school that writes Planering: no brick for the one that does not, and the list is marked for the layout to hide", async () => {
    renderPage();
    await ready();
    expect(screen.getByTestId("brick-block").closest("[data-writes]")?.getAttribute("data-writes")).toBe("PLANERING");
  });
});

describe("the week", () => {
  it("draws ONE card for a lesson of the block, named by the lesson, with the block's name, the posts' subjects and how many chose a room", async () => {
    renderPage();
    await ready();
    const card = cardOf(TUESDAY)!;
    expect(card).toBeInTheDocument();
    expect(card).toHaveTextContent("Språkval åk 7");
    expect(card).toHaveTextContent("Franska · Spanska · Tyska");
    expect(card).toHaveTextContent("block.cardRooms(1|3)");
    // A card for the lesson, not one for each of the three posts.
    expect(document.querySelectorAll("[data-lesson-id^='blockplacement:']")).toHaveLength(1);
  });

  it("rings a lesson that does not hold, and says it in the red box once, with the posts that fail for one sentence said together", async () => {
    state.board = board({
      blocks: [
        theBlock({
          rows: [
            lesson({
              verdicts: [
                { requirementId: "m-fr", ok: false, reason: "TEACHER", params: { otherKind: "LESSON", className: "7A", subjectName: "Matematik", day: 2, start: "08:00", end: "09:00" } },
                { requirementId: "m-sp", ok: false, reason: "TEACHER", params: { otherKind: "LESSON", className: "7A", subjectName: "Matematik", day: 2, start: "08:00", end: "09:00" } },
                { requirementId: "m-ty", ok: true },
              ],
            }),
          ],
        }),
      ],
    });
    renderPage();
    await ready();
    expect(cardOf(TUESDAY)).toHaveClass("ring-destructive");
    expect(screen.getByText("failingTitle(1)")).toBeInTheDocument();
    const lines = screen.getAllByTestId("failing-row");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent("Språkval åk 7");
    // Franska Fr7 and Spanska Sp7 fail for one sentence: said together; Tyska does not hold nothing.
    expect(lines[0]).toHaveTextContent("block.postSaid(Franska Fr7 och Spanska Sp7|verdict.TEACHER");
    expect(lines[0]).not.toHaveTextContent("Tyska");
  });

  it("counts a block's lesson once in the figures: as a row, and as one lesson left, not one for each post", async () => {
    renderPage();
    await ready();
    // One block lesson placed (one row); left: two for the ordinary post and one for the block (its three posts' 1 + 1 + 1 are not added).
    expect(screen.getByTestId("placement-summary")).toHaveTextContent("summary(1|3)");
  });

  it("is told nothing of the blocks by a gateway that has none: the field is missing, and there are no blocks", async () => {
    const { blocks: _gone, ...older } = board();
    state.board = older;
    renderPage();
    await ready();
    expect(blockBricks()).toHaveLength(0);
    expect(document.querySelectorAll("[data-lesson-id^='blockplacement:']")).toHaveLength(0);
    // A year with no block has no list of blocks, and is not told "no blocks".
    expect(screen.queryByTestId("placement-blocks-empty")).not.toBeInTheDocument();
    expect(document.getElementById("placement-blocks")).toBeNull();
  });

  it("says so in the list when every block is hidden by the filters", async () => {
    renderPage();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
    expect(await screen.findByTestId("placement-blocks-empty")).toBeInTheDocument();
  });
});

describe("the lists under the week", () => {
  it("lists the block with its lessons, the verdict of each and when it was saved; and its posts say that they are laid with the block, naming it", async () => {
    renderPage();
    await ready();
    const entry = screen.getAllByTestId("placement-block")[0]!;
    expect(entry).toHaveTextContent("Språkval åk 7");
    expect(entry).toHaveTextContent("block.blockFigures(1|2|1)");
    expect(within(entry).getByTestId("placement-block-row")).toHaveTextContent("holds");
    expect(within(entry).getByText(/savedAt/)).toBeInTheDocument();
    // The post of the block says which block it is laid with, not just that it is in one.
    const post = screen.getAllByTestId("placement-post").find((item) => item.textContent?.includes("Franska Fr7"))!;
    expect(post).toHaveTextContent("block.memberOf(Språkval åk 7)");
    expect(post).not.toHaveTextContent("fit.BLOCK");
  });

  it("says why a block that follows another cannot be placed, naming the one it follows", async () => {
    renderPage();
    await ready();
    const follower = screen.getAllByTestId("placement-block").find((item) => item.textContent?.includes("Följare"))!;
    expect(follower).toHaveTextContent("fit.FOLLOWER");
  });

  it("is reached from the card's dialog, which links to the block's line", async () => {
    renderPage();
    await ready();
    await userEvent.click(cardOf(TUESDAY)!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "block.toBlock" })).toHaveAttribute("href", "#block-b-sv");
    expect(document.getElementById("block-b-sv")).toBeInTheDocument();
  });
});

describe("laying a lesson of a block: press the brick, then a time", () => {
  it("chooses the brick, shows the row with a room for each post, and lays the lesson for all of them where the week is pressed", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await userEvent.click(blockBricks()[0]!);
    const row = await screen.findByTestId("lay-row");
    expect(row).toHaveTextContent("layChosen(block.brickLabel(Språkval åk 7|60|3))");
    // A room for each post, "Motorn väljer sal" first: the post whose own lessons stand in a room is offered it, the others none.
    for (const post of ["Franska Fr7", "Spanska Sp7", "Tyska Ty7"]) expect(await within(row).findByRole("combobox", { name: `block.roomOf(${post})` })).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "block.roomOf(Tyska Ty7)" })).toHaveValue("r-ty");
    expect(within(row).getByRole("combobox", { name: "block.roomOf(Franska Fr7)" })).toHaveValue("");

    fireEvent.click(columns()[2]!, at(3, 13, 30));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [path, body] = lastPut();
    expect(path).toBe("/api/v1/teaching-blocks/b-sv/placements");
    // The whole list, on top of the key the board held: the lesson that was there with its room, and the new one with the room offered.
    expect(body.baseKey).toBe("bk000000000000001");
    expect(body.placements).toEqual([
      { dayOfWeek: 2, startTime: "08:00", minutes: 60, rooms: [TY_ROOM] },
      { dayOfWeek: 3, startTime: "13:30", minutes: 60, rooms: [TY_ROOM] },
    ]);
    expect(await screen.findByTestId("placement-status")).toHaveTextContent("placed(Språkval åk 7|3 13:30–14:30) fromNextGenerate");
    await waitFor(() => expect(cardOf("b-sv|60|3|13:30|ALL_WEEKS")).toBeInTheDocument());
    // The block's lessons are all laid: the brick is gone, and so is the row.
    await waitFor(() => expect(blockBricks()).toHaveLength(0));
    expect(screen.queryByTestId("lay-row")).not.toBeInTheDocument();
  });

  it("leaves the keyboard on the card that was laid", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await userEvent.click(blockBricks()[0]!);
    await screen.findByTestId("lay-row");
    fireEvent.click(columns()[0]!, at(1, 9));
    await waitFor(() => expect(document.activeElement).toBe(cardOf("b-sv|60|1|09:00|ALL_WEEKS")));
  });

  it("says that a press outside the school day is outside it, and writes nothing", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await userEvent.click(blockBricks()[0]!);
    await screen.findByTestId("lay-row");
    fireEvent.click(columns()[2]!, at(3, 17, 30));
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("cannotStandThere(outsideDay)");
    await noWrite();
  });
});

describe("laying a lesson of a block: pull the brick into the week", () => {
  it("lays the lesson where it is let go, for every post, with the rooms offered", async () => {
    pinGeometry();
    renderPage();
    await ready();
    pullBlockBrick(at(5, 9, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements.at(-1)).toEqual({ dayOfWeek: 5, startTime: "09:15", minutes: 60, rooms: [TY_ROOM] });
    expect(lastPut()[1].baseKey).toBe("bk000000000000001");
  });

  it("does not pull with a finger, which scrolls the list; and lays nothing when it is let go outside the week", async () => {
    pinGeometry();
    renderPage();
    await ready();
    fireEvent.pointerDown(blockBricks()[0]!, { pointerId: 1, button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(5, 9, 15) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(5, 9, 15) });
    await noWrite();
  });

  it("says which POST clashes and why, writes nothing, and leaves the brick where it was, when the mirror refuses the drop", async () => {
    pinGeometry();
    // The teacher of the Spanish post teaches a lesson Generera keeps on Wednesday at 10:00.
    state.board = board({
      kept: [{ id: "k-sp", dayOfWeek: 3, startTime: "10:00", endTime: "11:00", studentGroupId: "g-7a", extraGroupIds: [], subjectId: "s-ma", teacherId: "t-sp", coTeacherId: null, roomId: null, recurrence: "ALL_WEEKS", startDate: null, endDate: null, locked: true, generated: false }],
    });
    renderPage();
    await ready();
    pullBlockBrick(at(3, 10, 15));
    const message = await screen.findByTestId("placement-message");
    expect(message).toHaveTextContent("block.cannotStandThere(Spanska Sp7|verdict.TEACHER(LESSON|7A|Matematik|3|10:00|11:00))");
    expect(api.put).not.toHaveBeenCalled();
    expect(blockBricks()).toHaveLength(1);
  });

  it("says the gateway's sentence, naming the post, when the gateway refuses what the mirror let through, and leaves the brick where it was", async () => {
    pinGeometry();
    // The new lesson is the second of the list that was sent; the gateway names it by that place, and the post of the block that clashes.
    state.refuse = () => new ApiError(409, "no", "BLOCK_PLACEMENT_REFUSED", { index: 1, requirementId: "m-fr", reason: "ROOM", otherKind: "LESSON", className: "7A", subjectName: "Matematik", day: 3, start: "13:00", end: "14:00" });
    renderPage();
    await ready();
    pullBlockBrick(at(3, 13, 0));
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("block.cannotStandThere(Franska Fr7|verdict.ROOM(LESSON|7A|Matematik|3|13:00|14:00))");
    expect(blockBricks()).toHaveLength(1);
    expect(cardOf("b-sv|60|3|13:00|ALL_WEEKS")).not.toBeInTheDocument();
  });
});

describe("laying a lesson of a block: with the keyboard", () => {
  it("chooses the brick with Enter, takes a day, a start and a room for each post, and lays it with the button; a post left on the engine's choice is sent without one", async () => {
    renderPage();
    await ready();
    blockBricks()[0]!.focus();
    await userEvent.keyboard("{Enter}");
    const row = await screen.findByTestId("lay-row");
    await waitFor(() => expect(document.activeElement).toBe(within(row).getByRole("combobox", { name: "day" })));
    expect(within(row).getByTestId("place-verdict")).toHaveTextContent("free");

    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "day" }), "3");
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "13:15" } });
    // "Motorn väljer sal" is a choice a reader can make from the list, and the posts are asked one by one.
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "block.roomOf(Franska Fr7)" }), "r-a12");
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "block.roomOf(Tyska Ty7)" }), "");
    await userEvent.click(within(row).getByRole("button", { name: "lay" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements.at(-1)).toEqual({ dayOfWeek: 3, startTime: "13:15", minutes: 60, rooms: [{ requirementId: "m-fr", roomId: "r-a12" }] });
    await waitFor(() => expect(document.activeElement).toBe(cardOf("b-sv|60|3|13:15|ALL_WEEKS")));
  });

  it("says in words which post clashes when the time is taken, and steps to the next time that is free for all of them", async () => {
    // The Tyska post's teacher is busy on Monday 08:00-09:00, which is the first time the fields would start at.
    state.board = board({
      kept: [{ id: "k-ty", dayOfWeek: 1, startTime: "08:00", endTime: "09:00", studentGroupId: "g-7a", extraGroupIds: [], subjectId: "s-ma", teacherId: "t-ty", coTeacherId: null, roomId: null, recurrence: "ALL_WEEKS", startDate: null, endDate: null, locked: true, generated: false }],
    });
    renderPage();
    await ready();
    await userEvent.click(blockBricks()[0]!);
    const row = await screen.findByTestId("lay-row");
    // The fields start at the first free time, which is not Monday 08:00.
    expect(within(row).getByLabelText("start")).toHaveValue("09:00");
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "08:30" } });
    await waitFor(() => expect(within(row).getByTestId("place-verdict")).toHaveTextContent("block.postSaid(Tyska Ty7|verdict.TEACHER"));
    fireEvent.change(within(row).getByLabelText("start"), { target: { value: "08:00" } });
    await userEvent.click(within(row).getByRole("button", { name: "nextFree" }));
    await waitFor(() => expect(within(row).getByLabelText("start")).toHaveValue("09:00"));
    expect(within(row).getByTestId("place-verdict")).toHaveTextContent("free");
  });

  it("says the gateway's sentence under the fields when it refuses, until a field changes", async () => {
    state.refuse = () => new ApiError(409, "no", "BLOCK_PLACEMENT_REFUSED", { index: 1, requirementId: "m-sp", reason: "TEACHER", otherKind: "LESSON", className: "7A", subjectName: "Matematik", day: 1, start: "09:00", end: "10:00" });
    renderPage();
    await ready();
    await userEvent.click(blockBricks()[0]!);
    const row = await screen.findByTestId("lay-row");
    await userEvent.click(within(row).getByRole("button", { name: "lay" }));
    await waitFor(() => expect(within(row).getByTestId("place-verdict")).toHaveTextContent("block.postSaid(Spanska Sp7|verdict.TEACHER"));
    await userEvent.selectOptions(within(row).getByRole("combobox", { name: "day" }), "4");
    await waitFor(() => expect(within(row).getByTestId("place-verdict")).toHaveTextContent("free"));
  });
});

describe("moving and taking away a lesson of a block", () => {
  it("moves a card by an arrow key, a quarter of an hour, and sends the lesson with the rooms its posts chose; the keyboard stays on the card", async () => {
    renderPage();
    await ready();
    cardOf(TUESDAY)!.focus();
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[0]).toBe("/api/v1/teaching-blocks/b-sv/placements");
    expect(lastPut()[1].placements).toEqual([{ dayOfWeek: 2, startTime: "08:15", minutes: 60, rooms: [TY_ROOM] }]);
    expect(lastPut()[1].baseKey).toBe("bk000000000000001");
    await waitFor(() => expect(document.activeElement).toBe(cardOf("b-sv|60|2|08:15|ALL_WEEKS")));
    expect(screen.getByTestId("placement-status")).toHaveTextContent("moved(Språkval åk 7|2 08:15–09:15) fromNextGenerate");
  });

  it("is not in its own way when it is moved a quarter of an hour: the mirror lets it", async () => {
    renderPage();
    await ready();
    cardOf(TUESDAY)!.focus();
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("placement-message")).not.toBeInTheDocument();
  });

  it("moves a card that is pulled to another time, and never changes its length", async () => {
    pinGeometry();
    renderPage();
    await ready();
    const card = cardOf(TUESDAY)!;
    fireEvent.pointerDown(card, { pointerId: 1, button: 0, ...at(2, 8, 30) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(4, 10, 0) });
    fireEvent.pointerMove(window, { pointerId: 1, ...at(4, 10, 0) });
    fireEvent.pointerUp(window, { pointerId: 1, ...at(4, 10, 0) });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toHaveLength(1);
    expect(lastPut()[1].placements[0]).toMatchObject({ dayOfWeek: 4, minutes: 60, rooms: [TY_ROOM] });
  });

  it("changes a card's day, start and the rooms of its posts in its dialog", async () => {
    renderPage();
    await ready();
    await userEvent.click(cardOf(TUESDAY)!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("card-verdict")).toHaveTextContent("holds");
    // Each post's room, as the lesson has it: Tyska in its room, the others on the engine's choice.
    expect(within(dialog).getByRole("combobox", { name: "block.roomOf(Tyska Ty7)" })).toHaveValue("r-ty");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "block.roomOf(Spanska Sp7)" }), "r-a12");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "day" }), "5");
    await userEvent.click(within(dialog).getByRole("button", { name: "save" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 5, startTime: "08:00", minutes: 60, rooms: [{ requirementId: "m-sp", roomId: "r-a12" }, TY_ROOM] },
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("takes a lesson away without asking (a block has no pairs), and it is a brick to lay again", async () => {
    renderPage();
    await ready();
    await userEvent.click(cardOf(TUESDAY)!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "remove" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([]);
    expect(lastPut()[1].baseKey).toBe("bk000000000000001");
    await waitFor(() => expect(blockBricks().map((brick) => brick.dataset["brick"])).toEqual(["block:b-sv|60#1", "block:b-sv|60#2"]));
    expect(screen.getByTestId("placement-status")).toHaveTextContent("removed(Språkval åk 7) fromNextGenerate");
    // The keyboard goes to the brick the lesson became, not to the card that is gone.
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-brick^='block:b-sv|60#']")));
  });

  it("keeps another lesson's rooms when one lesson is moved: every other lesson goes back as it is", async () => {
    state.board = board({ blocks: [theBlock({ lengths: [60, 60, 60], rows: [lesson(), lesson({ id: "br-2", dayOfWeek: 4, startTime: "13:00", endTime: "14:00", rooms: [{ requirementId: "m-fr", roomId: "r-a12", roomName: "A12" }] })] }), board().blocks[1]!] });
    renderPage();
    await ready();
    cardOf(TUESDAY)!.focus();
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements).toEqual([
      { dayOfWeek: 2, startTime: "08:15", minutes: 60, rooms: [TY_ROOM] },
      { dayOfWeek: 4, startTime: "13:00", minutes: 60, rooms: [{ requirementId: "m-fr", roomId: "r-a12" }] },
    ]);
  });
});

describe("undo and redo", () => {
  it("writes the block's list as it was back, on top of the key the last write left, and says what it undid; then forward again", async () => {
    renderPage();
    await ready();
    cardOf(TUESDAY)!.focus();
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const keyAfterMove = blockOf().rowsKey;
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].baseKey).toBe(keyAfterMove);
    expect(lastPut()[1].placements).toEqual([{ dayOfWeek: 2, startTime: "08:00", minutes: 60, rooms: [TY_ROOM] }]);
    await waitFor(() => expect(screen.getByTestId("placement-status")).toHaveTextContent("undone(stepMove) fromNextGenerate"));
    await userEvent.click(screen.getByRole("button", { name: "redo" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(3));
    expect(lastPut()[1].placements[0]).toMatchObject({ startTime: "08:15" });
  });

  it("is refused, with a message, when somebody else has written the block since, and the history is thrown away", async () => {
    renderPage();
    await ready();
    cardOf(TUESDAY)!.focus();
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeEnabled());
    // Somebody else writes the block: the gateway holds another key than ours.
    state.board = { ...(state.board as PlacementBoard), blocks: (state.board as PlacementBoard).blocks.map((entry) => (entry.id === "b-sv" ? { ...entry, rowsKey: "bk777777777777777" } : entry)) };
    await userEvent.click(screen.getByRole("button", { name: "undo" }));
    expect(await screen.findByTestId("placement-message")).toHaveTextContent(/stale/);
    // Nothing was written over their change, and the history is gone.
    await waitFor(() => expect(screen.getByRole("button", { name: "undo" })).toBeDisabled());
    expect(blockOf().rowsKey).toBe("bk777777777777777");
  });
});

describe("a block somebody else has written", () => {
  it("is refused with the block's own message, nothing is changed, and the week is read again; the same move then goes on top of the key the gateway has", async () => {
    renderPage();
    await ready();
    state.board = { ...(state.board as PlacementBoard), blocks: (state.board as PlacementBoard).blocks.map((entry) => (entry.id === "b-sv" ? { ...entry, rowsKey: "bk777777777777777" } : entry)) };
    const reads = api.get.mock.calls.length;
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("block.stale");
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(reads));
    expect(cardOf(TUESDAY)).toBeInTheDocument();
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    expect(lastPut()[1].baseKey).toBe("bk777777777777777");
  });

  it("says that Generera is writing, in the dialog's own sentence", async () => {
    state.refuse = () => new ApiError(409, "busy", "SCHEDULE_BUSY");
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("busy");
    expect(cardOf(TUESDAY)).toBeInTheDocument();
  });

  it("says that the lessons do not fit the block, in the dialog's words for the rule, and writes nothing", async () => {
    state.refuse = () => new ApiError(409, "no", "BLOCK_PLACEMENTS_DO_NOT_FIT", { reason: "COUNT", index: 1 });
    renderPage();
    await ready();
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("notSaved");
    expect(screen.getByTestId("placement-message")).toHaveTextContent("fit.COUNT");
  });

  it("reads the week again after a refusal that says the block is not what the page holds (the app does not read again at a window's focus), so that the next try is made on what the block is now", async () => {
    state.refuse = () => new ApiError(409, "no", "BLOCK_PLACEMENTS_DO_NOT_FIT", { reason: "COUNT", index: 1 });
    renderPage();
    await ready();
    const reads = api.get.mock.calls.length;
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("fit.COUNT");
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(reads));
  });
});

describe("a lesson of the block that does not hold stays (rest of the review of #328)", () => {
  const redBoard = () =>
    board({
      blocks: [
        theBlock({
          lengths: [60, 60, 60],
          rows: [
            lesson({
              id: "br-red",
              dayOfWeek: 2,
              startTime: "08:00",
              endTime: "09:00",
              verdicts: [
                { requirementId: "m-fr", ok: true },
                { requirementId: "m-sp", ok: false, reason: "TEACHER", params: { otherKind: "LESSON", className: "7A", subjectName: "Matematik", day: 2, start: "08:00", end: "09:00" } },
                { requirementId: "m-ty", ok: true },
              ],
            }),
          ],
        }),
      ],
    });

  it("is named, by lesson and post, in the message after a change beside it, and the change is said to have been made", async () => {
    state.board = redBoard();
    state.failingDay = 2;
    pinGeometry();
    renderPage();
    await ready();
    pullBlockBrick(at(4, 10, 0));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const status = await screen.findByTestId("placement-message");
    expect(status).toHaveTextContent("block.stillFailing(1|2 08:00–09:00:");
    expect(status).toHaveTextContent("block.postSaid(Spanska Sp7|verdict.TEACHER");
    expect(status).toHaveTextContent("placed(Språkval åk 7|4 10:00–11:00) fromNextGenerate");
  });

  it("says about the OTHER lesson when the gateway names one: a lesson that stopped holding refuses a change of another", async () => {
    state.board = redBoard();
    // The red lesson is the first of the list that was sent; the lesson that was changed is the second.
    state.refuse = () => new ApiError(409, "no", "BLOCK_PLACEMENT_REFUSED", { index: 0, requirementId: "m-sp", reason: "TEACHER", otherKind: "LESSON", className: "7A", subjectName: "Matematik", day: 2, start: "08:00", end: "09:00" });
    pinGeometry();
    renderPage();
    await ready();
    pullBlockBrick(at(4, 10, 0));
    const message = await screen.findByTestId("placement-message");
    expect(message).toHaveTextContent("block.otherRowRefused(2 08:00–09:00|block.postSaid(Spanska Sp7|verdict.TEACHER");
    expect(message).not.toHaveTextContent("cannotStandThere");
  });

  it("says that a new lesson beside the red one is refused until the red one is moved or taken away, when the mirror finds the red lesson in the way", async () => {
    state.board = redBoard();
    pinGeometry();
    renderPage();
    await ready();
    // The block's second lesson, pulled onto the red one: the teachers of its posts are in the way, in the red lesson.
    pullBlockBrick(at(2, 8, 30));
    const message = await screen.findByTestId("placement-message");
    expect(message).toHaveTextContent("block.cannotStandThere(Franska Fr7|verdict.TEACHER(PLACEMENT|Fr7|Franska|2|08:00|09:00))");
    expect(message).toHaveTextContent("block.meetsRed(2 08:00–09:00)");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("says it too when it is the gateway that finds the red lesson in the way, naming it as the other lesson", async () => {
    state.board = redBoard();
    pinGeometry();
    state.refuse = () => new ApiError(409, "no", "BLOCK_PLACEMENT_REFUSED", { index: 1, requirementId: "m-sp", reason: "TEACHER", otherKind: "PLACEMENT", className: "Sp7", subjectName: "Spanska", day: 2, start: "08:00", end: "09:00" });
    renderPage();
    await ready();
    pullBlockBrick(at(4, 10, 0));
    const message = await screen.findByTestId("placement-message");
    expect(message).toHaveTextContent("block.cannotStandThere(Spanska Sp7");
    expect(message).toHaveTextContent("block.meetsRed(2 08:00–09:00)");
  });

  it("does not say it when the lesson in the way is one that holds", async () => {
    pinGeometry();
    state.refuse = () => new ApiError(409, "no", "BLOCK_PLACEMENT_REFUSED", { index: 1, requirementId: "m-sp", reason: "TEACHER", otherKind: "PLACEMENT", className: "Sp7", subjectName: "Spanska", day: 2, start: "08:00", end: "09:00" });
    renderPage();
    await ready();
    pullBlockBrick(at(4, 10, 0));
    const message = await screen.findByTestId("placement-message");
    expect(message).toHaveTextContent("block.cannotStandThere(Spanska Sp7");
    expect(message).not.toHaveTextContent("meetsRed");
  });
});

describe("the filters", () => {
  it("shows a block's card for the class of any of its posts, hides it for another class, and keeps the brick for the others", async () => {
    renderPage();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Sp7" }));
    expect(cardOf(TUESDAY)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Sp7" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
    await waitFor(() => expect(cardOf(TUESDAY)).not.toBeInTheDocument());
    // The block's brick follows the class filter too: no member is 7A.
    expect(blockBricks()).toHaveLength(0);
  });

  it("shows a block's lesson for a picked room that one of its posts chose, and no lesson for a room nobody chose", async () => {
    renderPage();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /filterRoom/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Tyska-salen" }));
    expect(cardOf(TUESDAY)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Tyska-salen" }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "A12" }));
    await waitFor(() => expect(cardOf(TUESDAY)).not.toBeInTheDocument());
  });

  it("names a lesson the same whatever is filtered, so that hiding another lesson does not rename it", async () => {
    state.board = board({ blocks: [theBlock({ lengths: [60, 60, 60], rows: [lesson({ id: "a" }), lesson({ id: "b", rooms: [] })] })] });
    renderPage();
    await ready();
    expect(cardOf(TUESDAY)).toBeInTheDocument();
    expect(cardOf(`${TUESDAY}#2`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /filterRoom/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Tyska-salen" }));
    // The lesson with the room is the first; it is still the first. The other is hidden.
    expect(cardOf(TUESDAY)).toBeInTheDocument();
    expect(cardOf(`${TUESDAY}#2`)).not.toBeInTheDocument();
  });
});

describe("the school that does not write Planering, and the reader", () => {
  it("sees the block's card and opens it, but is offered no brick, no fields to move it with and no way to take it away", async () => {
    state.adminProfile = "EXPEDITION";
    renderPage();
    await ready();
    expect(bricks()).toHaveLength(0);
    expect(columns()).toHaveLength(0);
    expect(cardOf(TUESDAY)).toBeInTheDocument();
    await userEvent.click(cardOf(TUESDAY)!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("card-verdict")).toHaveTextContent("holds");
    expect(within(dialog).queryByRole("button", { name: "save" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "remove" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(api.put).not.toHaveBeenCalled();
  });

  it("has no way in from the keyboard either (Läsbehörighet)", async () => {
    state.adminProfile = "LASARE";
    state.readOnly = true;
    renderPage();
    await ready();
    expect(blockBricks()).toHaveLength(0);
    fireEvent.keyDown(cardOf(TUESDAY)!, { key: "ArrowDown" });
    await noWrite();
  });
});

describe("the link that names a lesson of a block", () => {
  it("marks the card of the lesson that stands where the address says, moves the keyboard to it, and opens nothing", async () => {
    window.history.replaceState(null, "", "/sv/admin/placements?year=y1&post=m-sp&day=2&start=08:00&block=b-sv");
    renderPage();
    await ready();
    await waitFor(() => expect(document.activeElement).toBe(cardOf(TUESDAY)));
    expect(cardOf(TUESDAY)).toHaveClass("outline-2");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("placement-link-gone")).not.toBeInTheDocument();
  });

  it("marks the block's card from the very address Generera's \"Visa i veckan\" builds for a block's row (A3's LÅG-5): the post is the member, the block rides along", async () => {
    // The same builder the Generera page uses for a refusal that names a block's lesson (placement-link.ts), not an address written by hand here.
    const href = placementLinkOf({ yearId: null, postId: "m-sp", blockId: "b-sv", day: 2, start: "08:00" });
    window.history.replaceState(null, "", `/sv${href}`);
    renderPage();
    await ready();
    await waitFor(() => expect(document.activeElement).toBe(cardOf(TUESDAY)));
    expect(cardOf(TUESDAY)).toHaveClass("outline-2");
    // The post's own card hook (A3) has nothing to mark for a member (it has no rows) and says nothing is missing.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("placement-link-gone")).not.toBeInTheDocument();
  });

  it("says in words that the lesson is not there any more, and marks nothing, when the block has none where the address says", async () => {
    window.history.replaceState(null, "", "/sv/admin/placements?post=m-sp&day=4&start=13:00&block=b-sv");
    renderPage();
    await ready();
    expect(await screen.findByTestId("placement-link-gone")).toHaveAttribute("role", "status");
    expect(cardOf(TUESDAY)).not.toHaveClass("outline-2");
  });

  it("does nothing for an address without a block, or with a day or a start that is none, and never builds a selector of what it was given", async () => {
    window.history.replaceState(null, "", "/sv/admin/placements?post=m-sp&day=9&start=08:00&block=%22%5D%2Cbody");
    renderPage();
    await ready();
    expect(screen.queryByTestId("placement-link-gone")).not.toBeInTheDocument();
    expect(cardOf(TUESDAY)).not.toHaveClass("outline-2");
  });
});

/* ------------------------------------------------------------------------------------------------------------------------------------------ */
/* Prov för mutanter som överlevde (granskning av #331): längden på ett blockkort, brickor under salsfiltret, utkastets salar vid dragning, markeringen som slutar, brickan som väljs bort. */
/* ------------------------------------------------------------------------------------------------------------------------------------------ */
describe("what hand mutants of the week's block code left untested", () => {
  it("a block's card is not stretched: a drag at its foot is refused with the reason, and nothing is written", async () => {
    pinGeometry();
    renderPage();
    await ready();
    // Tuesday's card, which nothing stands beside: its foot pulled down is a longer lesson the week would hold, if lengths were free.
    fireEvent.pointerDown(cardOf(TUESDAY)!, { pointerId: 1, button: 0, clientX: 56 + 150, clientY: 653 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 56 + 150, clientY: 659 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 56 + 150, clientY: 659 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 56 + 150, clientY: 659 });
    expect(await screen.findByTestId("placement-message")).toHaveTextContent("cannotMoveThere(lengthCannotChange)");
    await noWrite();
  });

  it("the bricks are counted over the class and teacher filters and NOT over the room filter (a lesson laid in another room is still a lesson that is laid)", async () => {
    state.board = board({ blocks: [theBlock({ lengths: [60, 60, 60], rows: [lesson({ id: "a" }), lesson({ id: "b", rooms: [], dayOfWeek: 4 })] })] });
    renderPage();
    await ready();
    expect(blockBricks()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /filterRoom/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Tyska-salen" }));
    await waitFor(() => expect(cardOf(`${TUESDAY}`)).toBeInTheDocument());
    // One lesson of the block is left whatever room is picked; a filter that counted only the lessons in the room would offer two.
    expect(blockBricks()).toHaveLength(1);
  });

  it("a chosen brick that is pulled into the week is laid with the rooms the fields hold, not with the suggestion", async () => {
    pinGeometry();
    renderPage();
    await ready();
    await userEvent.click(blockBricks()[0]!);
    const row = await screen.findByTestId("lay-row");
    await userEvent.selectOptions(await within(row).findByRole("combobox", { name: "block.roomOf(Spanska Sp7)" }), "r-a12");
    pullBlockBrick(at(5, 9, 15));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(lastPut()[1].placements.at(-1)).toEqual({ dayOfWeek: 5, startTime: "09:15", minutes: 60, rooms: [{ requirementId: "m-sp", roomId: "r-a12" }, TY_ROOM] });
  });

  it("the card an address marked is no longer marked when another card is opened", async () => {
    window.history.replaceState(null, "", "/sv/admin/placements?post=m-sp&day=2&start=08:00&block=b-sv");
    state.board = board({ blocks: [theBlock({ rows: [lesson({ id: "a" }), lesson({ id: "b", dayOfWeek: 4, startTime: "13:00", endTime: "14:00" })] })] });
    renderPage();
    await ready();
    await waitFor(() => expect(cardOf(TUESDAY)).toHaveClass("outline-2"));
    await userEvent.click(cardOf("b-sv|60|4|13:00|ALL_WEEKS")!);
    await screen.findByRole("dialog");
    expect(cardOf(TUESDAY)).not.toHaveClass("outline-2");
  });

  it("the brick that was laid is no longer the chosen one, and the row for it is gone, also when the block has another lesson of the same length left", async () => {
    pinGeometry();
    state.board = board({ blocks: [theBlock({ rows: [] })] });
    renderPage();
    await ready();
    await userEvent.click(blockBricks()[0]!);
    await screen.findByTestId("lay-row");
    fireEvent.click(columns()[0]!, at(1, 9));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(cardOf("b-sv|60|1|09:00|ALL_WEEKS")).toBeInTheDocument());
    // One more lesson of 60 minutes is left (a brick again named #1), but it was not chosen.
    expect(blockBricks()).toHaveLength(1);
    expect(screen.queryByTestId("lay-row")).not.toBeInTheDocument();
  });
});
