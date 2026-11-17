import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardBlock, BoardHold, PlacementBoard } from "@/lib/placement-board";
import type { PlacementWarning } from "@/lib/requirement-placements";
import PlacementsPage from "./page";

/**
 * Förlägg i veckan, the warnings (D1). What the gateway counts is its own specs'; here the page is held to what it makes of `warnings` and
 * `holds` on the week and of `warnings` in the answer of a save: a mark on a card that has one (a word and a sign, and the card's name carries
 * the sentences), the stronger word on a card where Generera will refuse, a line per warning in the list, ONCE PER POST however many rows it is
 * on, the sentences in a card's dialog, what is read out after a save, the other schools' bands for a teacher or a room that is picked, and a
 * gateway that sends none of it.
 *
 * The words of the warnings' own namespace carry it ("warnings.badge"), so that they are told from the page's words of the same name ("legend").
 */

const state = vi.hoisted(() => ({
  board: undefined as unknown,
  readOnly: false,
  /** What the fake PUT of a post answers as warnings, by the rows it wrote (none: a week that says nothing). */
  warnOnPut: null as null | ((rows: Array<{ id: string; requirementId: string }>) => unknown[]),
  /** The warnings the board has for the block's lessons after a write: they come with the week's own read, which a block's PUT does not answer with. */
  blockWarnAfterPut: false,
  /** A read of the week after the first one takes this long (ms), so that the read a write starts is in flight when the page asks for it. */
  slowReads: 0,
  keyCount: 0,
  rowCount: 0,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api }));
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({
    year: { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true },
    active: null,
    successor: null,
    choose: vi.fn(),
    rosters: null,
    rostersFailed: false,
  }),
}));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: { adminProfile: "SCHEMALAGGARE" } }),
  useReadOnly: () => state.readOnly,
}));
vi.mock("@/lib/queries", () => ({
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS", gradeLevel: 7 },
      { id: "g-7b", academicYearId: "y1", name: "7B", kind: "CLASS", gradeLevel: 7 },
      { id: "g-fr", academicYearId: "y1", name: "Fr7", kind: "TEACHING_GROUP", gradeLevel: null },
      { id: "g-sp", academicYearId: "y1", name: "Sp7", kind: "TEACHING_GROUP", gradeLevel: null },
    ],
    isLoading: false,
  }),
  useSubjects: () => ({
    data: [
      { id: "s-ma", name: "Matematik", color: "#2563eb" },
      { id: "s-sv", name: "Svenska", color: null },
      { id: "s-fr", name: "Franska", color: null },
      { id: "s-sp", name: "Spanska", color: null },
    ],
    isLoading: false,
  }),
  useRooms: () => ({ data: [{ id: "r-a12", name: "A12" }, { id: "r-gym", name: "Gymnastiksalen" }], isLoading: false }),
  usePeople: () => ({
    data: ["anna", "bo", "t-fr", "t-sp"].map((id) => ({ id, role: "TEACHER", firstName: id.toUpperCase(), lastName: "Lärare", isActive: true })),
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
  useTranslations: (namespace?: string) =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) => {
        const name = namespace === "placementWeek.warnings" ? `warnings.${key}` : key;
        return values ? `${name}(${Object.values(values).join("|")})` : name;
      },
      { has: () => true },
    ),
}));

// ------------------------------------------------------------------------------------------------ the week

const post = (id: string, group: string, subject: string, teacher: string, over: Record<string, unknown> = {}) => ({
  id,
  studentGroupId: group,
  subjectId: subject,
  teacherId: teacher,
  coTeacherId: null,
  recurrence: "ALL_WEEKS" as const,
  startDate: null,
  endDate: null,
  cannotPlace: null,
  parts: [{ teacherId: teacher, minutes: 60, count: 3, locked: 0, placed: 1, left: 2, cannotPlace: null }],
  rowsKey: "k000000000000001",
  ...over,
});

const row = (id: string, requirementId: string, dayOfWeek: number, start: string, end: string, roomId: string | null) => ({
  id,
  requirementId,
  dayOfWeek,
  startTime: start,
  endTime: end,
  minutes: 60,
  roomId,
  roomName: roomId === "r-a12" ? "A12" : null,
  recurrence: "ALL_WEEKS" as const,
  teacherId: null,
  changedAt: "2026-11-13T08:00:00.000Z",
  verdict: { ok: true },
});

const lessonOf = (id: string, day: number, start: string, end: string) => ({
  id,
  dayOfWeek: day,
  startTime: start,
  endTime: end,
  minutes: 60,
  recurrence: "ALL_WEEKS" as const,
  rooms: [],
  changedAt: "2026-11-13T08:00:00.000Z",
  verdicts: [
    { requirementId: "m-fr", ok: true },
    { requirementId: "m-sp", ok: true },
  ],
});

const theBlock = (): BoardBlock => ({
  id: "b-sv",
  name: "Språkval åk 7",
  memberIds: ["m-fr", "m-sp"],
  lengths: [60, 60],
  recurrence: "ALL_WEEKS",
  followsBlockId: null,
  cannotPlace: null,
  rows: [lessonOf("br-1", 3, "08:00", "09:00")],
  rowsKey: "bk000000000000001",
});

const DAY_PARAMS = { day: 2, minutes: 470, cap: 420 };
const warn = (rowId: string, requirementId: string, over: Partial<PlacementWarning> = {}): PlacementWarning => ({
  code: "TEACHER_DAY_TOO_LONG",
  refuses: false,
  params: DAY_PARAMS,
  rowId,
  requirementId,
  ...over,
});
const LUNCH = { code: "CLASS_HAS_NO_LUNCH", refuses: true, params: { day: 2, windowStart: "10:30", windowEnd: "13:00", minutes: 30 } } as const;
const NO_ROOM = { code: "NO_ROOM_FREE", refuses: true, params: { day: 3, start: "08:00", end: "09:00", roomType: "Språksal" } } as const;

const MA_TUE = "post-ma||60|2|10:00|ALL_WEEKS";
const MA_TUE_LATE = "post-ma||60|2|13:00|ALL_WEEKS";
const SV_FRI = "post-sv||60|5|09:00|ALL_WEEKS";
const BLOCK_WED = "blockplacement:b-sv|60|3|08:00|ALL_WEEKS";
const cardOf = (key: string) => document.querySelector<HTMLElement>(`[data-lesson-id='placement:${key}']`)!;
const blockCard = () => document.querySelector<HTMLElement>(`[data-lesson-id='${BLOCK_WED}']`)!;

const baseBoard = (): PlacementBoard => ({
  academicYearId: "y1",
  posts: [
    post("post-ma", "g-7a", "s-ma", "anna"),
    post("post-sv", "g-7b", "s-sv", "bo"),
    post("m-fr", "g-fr", "s-fr", "t-fr", { cannotPlace: "BLOCK", rowsKey: "e3b0c44298fc1c14" }),
    post("m-sp", "g-sp", "s-sp", "t-sp", { cannotPlace: "BLOCK", rowsKey: "e3b0c44298fc1c14" }),
  ],
  placements: [
    row("row-ma", "post-ma", 2, "10:00", "11:00", "r-a12"),
    row("row-ma-late", "post-ma", 2, "13:00", "14:00", "r-a12"),
    row("row-sv", "post-sv", 5, "09:00", "10:00", null),
  ],
  kept: [],
  meals: [],
  blocks: [theBlock()],
  warnings: [
    // One warning on two rows of a post: said once in the list.
    warn("row-ma", "post-ma"),
    warn("row-ma-late", "post-ma"),
    warn("row-ma", "post-ma", LUNCH),
    // A reader without HR-läs is not told the limit.
    warn("row-sv", "post-sv", { code: "TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN", params: undefined }),
    // The same warning on two posts of a block's lesson: said once for the lesson.
    warn("br-1", "m-fr", { ...NO_ROOM, blockId: "b-sv" }),
    warn("br-1", "m-sp", { ...NO_ROOM, blockId: "b-sv" }),
  ],
  holds: [],
});

const withBoard = (over: Partial<PlacementBoard>) => {
  state.board = { ...baseBoard(), ...over };
};

/** The fake PUT of a post: its list replaced with new ids and a new key, `baseKey` checked; the warnings the test wants come in the answer. */
function fakePut(path: string, body: { placements: Array<Record<string, unknown>>; baseKey?: string }) {
  const current = state.board as PlacementBoard;
  if (path.includes("/teaching-blocks/")) return fakeBlockPut(path, body, current);
  const postId = /teaching-requirements\/([^/]+)\/placements/.exec(path)![1]!;
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
      roomName: roomId === "r-a12" ? "A12" : null,
      recurrence: input["recurrence"] as "ALL_WEEKS",
      teacherId: null,
    };
  });
  const rowsKey = `k9${String(++state.keyCount).padStart(14, "0")}`;
  const warnings = state.warnOnPut ? state.warnOnPut(written) : undefined;
  state.board = {
    ...current,
    placements: [...current.placements.filter((entry) => entry.requirementId !== postId), ...written.map((entry) => ({ ...entry, changedAt: "2026-11-16T09:00:00.000Z", verdict: { ok: true } }))],
    posts: current.posts.map((entry) => (entry.id === postId ? { ...entry, rowsKey } : entry)),
    warnings: [...(current.warnings ?? []).filter((entry) => entry.requirementId !== postId), ...((warnings as PlacementWarning[] | undefined) ?? [])],
  };
  return Promise.resolve({ placements: written, verdicts: written.map((_, index) => ({ index, ok: true })), rowsKey, ...(warnings ? { warnings } : {}) });
}

/** A block's PUT answers no warnings; the board's next read has them, on the new row's id. */
function fakeBlockPut(path: string, body: { placements: Array<Record<string, unknown>>; baseKey?: string }, current: PlacementBoard) {
  const blockId = /teaching-blocks\/([^/]+)\/placements/.exec(path)![1]!;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const written = body.placements.map((input) => {
    const start = Number(String(input["startTime"]).slice(0, 2)) * 60 + Number(String(input["startTime"]).slice(3, 5));
    return { ...lessonOf(`bn-${++state.rowCount}`, input["dayOfWeek"] as number, String(input["startTime"]), clock(start + Number(input["minutes"]))) };
  });
  const rowsKey = `bk9${String(++state.keyCount).padStart(13, "0")}`;
  state.board = {
    ...current,
    blocks: current.blocks.map((entry) => (entry.id === blockId ? { ...entry, rows: written, rowsKey } : entry)),
    warnings: [
      ...(current.warnings ?? []).filter((entry) => entry.blockId !== blockId),
      ...(state.blockWarnAfterPut ? written.flatMap((lesson) => ["m-fr", "m-sp"].map((requirementId) => warn(lesson.id, requirementId, { ...NO_ROOM, blockId }))) : []),
    ],
  };
  return Promise.resolve({
    placements: written.map((lesson) => ({ id: lesson.id, blockId, dayOfWeek: lesson.dayOfWeek, startTime: lesson.startTime, endTime: lesson.endTime, minutes: lesson.minutes, recurrence: lesson.recurrence, rooms: lesson.rooms })),
    verdicts: written.flatMap((_, index) => ["m-fr", "m-sp"].map((requirementId) => ({ index, requirementId, ok: true }))),
    rowsKey,
    lengths: [60, 60],
  });
}

let client: QueryClient;
const renderPage = () =>
  render(
    <QueryClientProvider client={client}>
      <PlacementsPage />
    </QueryClientProvider>,
  );
const ready = async () => {
  await screen.findByTestId("placement-summary");
};

beforeEach(() => {
  state.board = baseBoard();
  state.readOnly = false;
  state.warnOnPut = null;
  state.blockWarnAfterPut = false;
  state.slowReads = 0;
  state.keyCount = 0;
  state.rowCount = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let reads = 0;
  api.get.mockReset().mockImplementation(async () => {
    reads += 1;
    if (reads > 1 && state.slowReads > 0) await new Promise((resolve) => setTimeout(resolve, state.slowReads));
    return structuredClone(state.board);
  });
  api.put.mockReset().mockImplementation(fakePut);
  window.history.replaceState(null, "", "/sv/admin/placements");
});
afterEach(() => {
  vi.restoreAllMocks();
});

const postItem = (id: string) => document.getElementById(`post-${id}`)!;
const pickTeacher = async (name: string) => {
  await userEvent.click(screen.getByRole("button", { name: /filterTeacher/ }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
};
const pickRoom = async (name: string) => {
  await userEvent.click(screen.getByRole("button", { name: /filterRoom/ }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
};

// ------------------------------------------------------------------------------------------------ the card

describe("a card with a warning", () => {
  it("has a mark with a word, and the mark on a card is the post's own: a card without one has none", async () => {
    withBoard({ warnings: [warn("row-ma-late", "post-ma"), warn("row-sv", "post-sv", { code: "TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN", params: undefined })] });
    renderPage();
    await ready();
    expect(within(cardOf(MA_TUE_LATE)).getByText("warnings.badge")).toBeInTheDocument();
    expect(within(cardOf(SV_FRI)).getByText("warnings.badge")).toBeInTheDocument();
    // The first row of the post has no warning: no mark, and no hover text of a mark either.
    const plain = cardOf(MA_TUE);
    expect(within(plain).queryByText(/warnings\.badge/)).not.toBeInTheDocument();
    expect(plain.querySelector("[title]")).toBeNull();
    // Where the mark sits in the card (the smoke spec measures it there): in the header, beside the title, which the grid truncates and never the mark.
    const marks = document.querySelectorAll("[data-lesson-id] > div > div > span[title]");
    expect(Array.from(marks).map((mark) => mark.firstChild?.textContent)).toEqual(["warnings.badge", "warnings.badge"]);
  });

  it("has the stronger word where Generera will refuse, and keeps the word when only one of the warnings does", async () => {
    renderPage();
    await ready();
    // The first row has the day (which does not refuse) and the lunch (which does).
    expect(within(cardOf(MA_TUE)).getByText("warnings.badgeRefuses")).toBeInTheDocument();
    expect(within(cardOf(MA_TUE)).queryByText("warnings.badge")).not.toBeInTheDocument();
    expect(within(blockCard()).getByText("warnings.badgeRefuses")).toBeInTheDocument();
  });

  it("carries the sentences in its name, the day's and the lunch's, and what a refusal means once the card refuses", async () => {
    renderPage();
    await ready();
    const name = cardOf(MA_TUE).textContent!;
    expect(name).toContain("warnings.said(2|");
    expect(name).toContain("warnings.TEACHER_DAY_TOO_LONG(warnings.day(2)|470|420)");
    expect(name).toContain("warnings.CLASS_HAS_NO_LUNCH(warnings.day(2)|10:30|13:00|30) warnings.refuses");
    // A screen reader hears the same, in the name of the button; the hover on the mark has it too.
    expect(cardOf(MA_TUE)).toHaveAccessibleName(/warnings\.said\(2\|/);
    expect(cardOf(MA_TUE).querySelector("[title^='warnings.said']")).not.toBeNull();
  });

  it("says a warning that is on both of a block's posts once, on the lesson's card", async () => {
    renderPage();
    await ready();
    expect(blockCard().textContent).toContain("warnings.said(1|");
    expect(blockCard().textContent!.match(/warnings\.NO_ROOM_FREE/g)).toHaveLength(1);
  });

  it("is not a colour alone: the word is in the card and the legend names both marks", async () => {
    renderPage();
    await ready();
    const legend = screen.getByRole("list", { name: "legend" });
    expect(within(legend).getByText("warnings.legend")).toBeInTheDocument();
  });

  it("draws the legend's line only for a week that has a warning", async () => {
    withBoard({ warnings: [] });
    renderPage();
    await ready();
    expect(screen.queryByText("warnings.legend")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "legend" })).toBeInTheDocument();
  });

  it("is marked for the reader too, who sees the week and no bricks", async () => {
    state.readOnly = true;
    renderPage();
    await ready();
    expect(within(cardOf(MA_TUE_LATE)).getByText("warnings.badge")).toBeInTheDocument();
  });

  it("is not drawn for a warning that names no row of the week: its row is gone (a write gave the rows new ids)", async () => {
    withBoard({ warnings: [warn("an-old-row", "post-ma", LUNCH), warn("an-old-lesson", "m-fr", { ...NO_ROOM, blockId: "b-sv" })] });
    renderPage();
    await ready();
    expect(screen.queryByText(/warnings\.badge/)).not.toBeInTheDocument();
    expect(screen.queryByText("warnings.legend")).not.toBeInTheDocument();
    expect(screen.queryByTestId("placement-warnings")).not.toBeInTheDocument();
  });

  it("reads a row id as a post's row and not as a block's lesson's, and the other way round (the two are looked up in their own keys)", async () => {
    // A block's lesson and a post's row cannot share an id on a real board; here a warning for a block names a row id that is a POST's row only.
    withBoard({ warnings: [warn("row-ma", "m-fr", { ...NO_ROOM, blockId: "b-sv" })] });
    renderPage();
    await ready();
    expect(within(cardOf(MA_TUE)).queryByText(/warnings\.badge/)).not.toBeInTheDocument();
    expect(within(blockCard()).queryByText(/warnings\.badge/)).not.toBeInTheDocument();
  });
});

describe("a gateway from before the warnings", () => {
  it("draws the week as it did, with no mark, no line and no band, and nothing to say", async () => {
    const old = baseBoard() as Partial<PlacementBoard>;
    delete old.warnings;
    delete old.holds;
    state.board = old;
    renderPage();
    await ready();
    expect(cardOf(MA_TUE)).toBeInTheDocument();
    expect(screen.queryByText(/warnings\./)).not.toBeInTheDocument();
    expect(screen.queryByTestId("placement-warnings")).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ the list

describe("the list under the week", () => {
  it("says a warning once for a post, however many of its rows it is on, with the word and what a refusal means", async () => {
    renderPage();
    await ready();
    const lines = within(postItem("post-ma")).getAllByTestId("placement-warning");
    // The day is on two rows, the lunch on one: two lines.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("warnings.label warnings.TEACHER_DAY_TOO_LONG(warnings.day(2)|470|420)");
    expect(lines[0]).not.toHaveTextContent("warnings.refuses");
    expect(lines[1]).toHaveTextContent("warnings.CLASS_HAS_NO_LUNCH(warnings.day(2)|10:30|13:00|30) warnings.refuses");
  });

  it("does not say in the list that a lesson that does not refuse is saved (that is the dialog's sentence)", async () => {
    renderPage();
    await ready();
    expect(within(postItem("post-ma")).queryByText(/standsAnyway/)).not.toBeInTheDocument();
    expect(postItem("post-ma")).not.toHaveTextContent("warnings.standsAnyway");
  });

  it("says each post's own, and a post without any says none", async () => {
    renderPage();
    await ready();
    expect(within(postItem("post-sv")).getAllByTestId("placement-warning")).toHaveLength(1);
    expect(postItem("post-sv")).toHaveTextContent("warnings.TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN()".replace("()", ""));
    expect(within(postItem("m-fr")).queryByTestId("placement-warnings")).not.toBeInTheDocument();
  });

  it("says a block's warning once for the block, though two of its posts have it", async () => {
    renderPage();
    await ready();
    const block = screen.getByTestId("placement-block");
    expect(within(block).getAllByTestId("placement-warning")).toHaveLength(1);
    expect(block).toHaveTextContent("warnings.NO_ROOM_FREE(warnings.day(3)|08:00|09:00|Språksal) warnings.refuses");
  });

  it("says nothing of a post whose rows the filters hide", async () => {
    renderPage();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7B" }));
    expect(screen.queryByText(/warnings\.CLASS_HAS_NO_LUNCH/)).not.toBeInTheDocument();
    expect(screen.getAllByTestId("placement-warning")).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ the dialog

describe("a card opened", () => {
  it("says each warning with what it means for Generera, and leaves the judge's word as it was", async () => {
    renderPage();
    await ready();
    await userEvent.click(cardOf(MA_TUE));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("card-verdict")).toHaveTextContent("holds");
    const lines = within(dialog).getAllByTestId("placement-warning");
    expect(lines).toHaveLength(2);
    // A warning that does not refuse says that the lesson is saved and taken as it lies; one that refuses says Generera will refuse the week.
    expect(lines[0]).toHaveTextContent("warnings.TEACHER_DAY_TOO_LONG(warnings.day(2)|470|420) warnings.standsAnyway");
    expect(lines[1]).toHaveTextContent("warnings.CLASS_HAS_NO_LUNCH(warnings.day(2)|10:30|13:00|30) warnings.refuses");
    expect(lines[1]).not.toHaveTextContent("warnings.standsAnyway");
  });

  it("says a block's lesson's warning, once", async () => {
    renderPage();
    await ready();
    await userEvent.click(blockCard());
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByTestId("placement-warning")).toHaveLength(1);
  });

  it("has no list for a card without a warning", async () => {
    withBoard({ warnings: [warn("row-sv", "post-sv")] });
    renderPage();
    await ready();
    await userEvent.click(cardOf(MA_TUE));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByTestId("placement-warnings")).not.toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ after a save

describe("after a save", () => {
  it("reads the warnings out in the page's own polite region, with the mark on the card the keyboard goes to, before the week is read again", async () => {
    state.warnOnPut = (rows) => rows.flatMap((entry, index) => [warn(entry.id, entry.requirementId), ...(index === 0 ? [warn(entry.id, entry.requirementId, LUNCH)] : [])]);
    renderPage();
    await ready();
    // The read that follows the write never comes: what the card says is what the answer said.
    api.get.mockImplementation(() => new Promise(() => undefined));
    cardOf(MA_TUE).focus();
    fireEvent.keyDown(cardOf(MA_TUE), { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const moved = "post-ma||60|2|09:45|ALL_WEEKS";
    await waitFor(() => expect(document.activeElement).toBe(cardOf(moved)));
    const status = screen.getByTestId("placement-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("role", "status");
    // The day (on both rows of the answer) once, the lunch once: two, with what a refusal means after the one that refuses.
    expect(status).toHaveTextContent(/moved\(.*\) fromNextGenerate warnings\.said\(2\|warnings\.TEACHER_DAY_TOO_LONG\(warnings\.day\(2\)\|470\|420\) warnings\.CLASS_HAS_NO_LUNCH\(warnings\.day\(2\)\|10:30\|13:00\|30\) warnings\.refuses\)/);
    // The focused card's own name carries the warning, the moment it is focused.
    expect(within(cardOf(moved)).getByText("warnings.badgeRefuses")).toBeInTheDocument();
    expect(cardOf(moved)).toHaveAccessibleName(/warnings\.said\(2\|/);
  });

  it("reads out the warnings of the answer, in a status that is read out WITHOUT the verdict's words changing: the saved sentence stays what it was", async () => {
    state.warnOnPut = (rows) => rows.map((entry) => warn(entry.id, entry.requirementId));
    renderPage();
    await ready();
    cardOf(MA_TUE).focus();
    fireEvent.keyDown(cardOf(MA_TUE), { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByTestId("placement-status")).toHaveTextContent("warnings.said(1|"));
    expect(screen.getByTestId("placement-status")).toHaveTextContent("moved(Matematik 7A|2 09:45–10:45) fromNextGenerate");
  });

  it("says nothing of warnings after a save whose answer has none, and takes away what it said after the last", async () => {
    state.warnOnPut = (rows) => rows.map((entry) => warn(entry.id, entry.requirementId));
    renderPage();
    await ready();
    cardOf(MA_TUE).focus();
    fireEvent.keyDown(cardOf(MA_TUE), { key: "ArrowUp" });
    await waitFor(() => expect(screen.getByTestId("placement-status")).toHaveTextContent("warnings.said"));
    state.warnOnPut = null;
    const next = cardOf("post-ma||60|2|09:45|ALL_WEEKS");
    next.focus();
    fireEvent.keyDown(next, { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("placement-status")).toHaveTextContent("moved("));
    expect(screen.getByTestId("placement-status")).not.toHaveTextContent("warnings.");
  });

  it("says nothing of warnings after a save to a gateway that answers none", async () => {
    renderPage();
    await ready();
    cardOf(MA_TUE).focus();
    fireEvent.keyDown(cardOf(MA_TUE), { key: "ArrowUp" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("placement-status")).toHaveTextContent("moved("));
    expect(screen.getByTestId("placement-status")).not.toHaveTextContent("warnings.said");
  });

  it("reads a block's warnings out once the week has been read again, for a block's write answers none, and does not read the week twice", async () => {
    state.blockWarnAfterPut = true;
    state.slowReads = 40;
    withBoard({ warnings: [] });
    renderPage();
    await ready();
    blockCard().focus();
    // A quarter of an hour later (08:00 is the school day's first minute: up would be outside it).
    fireEvent.keyDown(blockCard(), { key: "ArrowDown" });
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("placement-status")).toHaveTextContent("warnings.said(1|warnings.NO_ROOM_FREE(warnings.day(3)|08:00|09:00|Språksal) warnings.refuses)"));
    // The write's own read is the one asked for: the page joins it and does not start another.
    expect(api.get).toHaveBeenCalledTimes(2);
    // And the lesson's card has its mark, on the new row's id.
    expect(within(document.querySelector<HTMLElement>("[data-lesson-id='blockplacement:b-sv|60|3|08:15|ALL_WEEKS']")!).getByText("warnings.badgeRefuses")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------ the other schools' bands

describe("the other schools' bands", () => {
  const hold = (over: Partial<BoardHold>): BoardHold => ({
    kind: "TEACHER_BUSY",
    resourceKind: "TEACHER",
    resourceId: "anna",
    dayOfWeek: 3,
    startTime: "13:00",
    endTime: "14:30",
    schools: ["Östra skolan"],
    ...over,
  });
  const HOLDS = [
    hold({}),
    hold({ resourceId: "bo", dayOfWeek: 4, schools: ["Norra skolan"] }),
    hold({ kind: "ROOM_LENT", resourceKind: "ROOM", resourceId: "r-gym", dayOfWeek: 1, startTime: "09:00", endTime: "10:00", schools: ["Södra skolan", "Östra skolan"] }),
  ];

  it("draws no band when no filter points at the teacher or the room", async () => {
    withBoard({ holds: HOLDS });
    renderPage();
    await ready();
    expect(screen.queryByText(/warnings\.hold/)).not.toBeInTheDocument();
  });

  it("draws the band for a teacher that is picked, with the schools by name, and not for the other teacher's", async () => {
    withBoard({ holds: HOLDS });
    renderPage();
    await ready();
    await pickTeacher("ANNA Lärare");
    expect(screen.getAllByText(/warnings\.hold/)).toHaveLength(1);
    expect(screen.getByText("warnings.hold(Östra skolan)")).toBeInTheDocument();
  });

  it("draws the band for a room that is picked, naming both schools, and goes when the filter does", async () => {
    withBoard({ holds: HOLDS });
    renderPage();
    await ready();
    await pickRoom("Gymnastiksalen");
    expect(screen.getByText("warnings.hold(Södra skolan och Östra skolan)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "clearFilters" }));
    expect(screen.queryByText(/warnings\.hold/)).not.toBeInTheDocument();
  });

  it("draws the bands behind the cards and as text, so that they are never a colour alone", async () => {
    withBoard({ holds: HOLDS });
    renderPage();
    await ready();
    await pickTeacher("ANNA Lärare");
    const band = screen.getByText("warnings.hold(Östra skolan)");
    // The grid's stripe: inert, so that a press on the empty hour under it still lays a lesson.
    expect(band.className).toContain("pointer-events-none");
  });
});
