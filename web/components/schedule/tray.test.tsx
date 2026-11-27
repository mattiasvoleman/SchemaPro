import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@/lib/api";
import type { BoardTray, TrayBrick } from "@/lib/board-tray";
import type { PossibleTimes, RoomChoice } from "@/lib/possible-times";
import { TrayHead, TrayPanel } from "./tray";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * ATT LÄGGA (E4) on the board's page: the head's button and figures, and the panel with the bricks, the form that lays one, and what it says when
 * the gateway says no. The gateway counts, ranks and judges; these tests hold what the page does with its answers, in both languages.
 */

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), api: { get, post } }));
vi.mock("sonner", () => ({ toast }));

const brick = (over: Partial<TrayBrick> = {}): TrayBrick => ({
  postId: "p1",
  nth: 1,
  partKey: "0123456789abcdef",
  lessonId: null,
  studentGroupId: "g1",
  subjectId: "s1",
  teacherId: "t1",
  coTeacherId: null,
  minutes: 60,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  blockId: null,
  cannotPlace: null,
  possibleTimes: null,
  ...over,
});
const TRAY: BoardTray = {
  academicYearId: "y1",
  bricks: [
    brick(),
    brick({ nth: 2 }),
    brick({ postId: "p2", studentGroupId: "g2", subjectId: "s2", teacherId: "t2", minutes: 45, recurrence: "ODD_WEEKS", lessonId: "l9", partKey: "aaaaaaaaaaaaaaaa" }),
    brick({ postId: "p3", studentGroupId: "g2", subjectId: "s2", teacherId: null, cannotPlace: "NO_TEACHER", partKey: "bbbbbbbbbbbbbbbb" }),
    brick({ postId: "p4", studentGroupId: "g1", subjectId: "s2", blockId: "b1", cannotPlace: "BLOCK", partKey: "cccccccccccccccc" }),
  ],
  tally: { lessons: 40, laid: 35, placedByRow: 0, left: 5 },
  groups: [{ studentGroupId: "g2", left: 2 }, { studentGroupId: "g1", left: 3 }, { studentGroupId: "g3", left: 0 }],
};

const groups = new Map([["g1", { name: "7A" }], ["g2", { name: "7B" }], ["g3", { name: "8A" }]]);
const subjects = new Map([["s1", { name: "Matematik" }], ["s2", { name: "Svenska" }]]);
const teachers = new Map([["t1", { firstName: "Anna", lastName: "Ek" }], ["t2", { firstName: "Bo", lastName: "Lind" }]]);

const room = (over: Partial<RoomChoice> & { roomId: string; name: string }): RoomChoice => ({
  capacity: 30,
  needed: 25,
  state: "FREE",
  tooSmall: false,
  typeOk: true,
  sameTypeAsOwn: true,
  allowed: true,
  current: false,
  shared: false,
  rank: null,
  occupant: null,
  occupants: 0,
  closedBy: null,
  closedParams: {},
  ...over,
});
const ROOMS = {
  academicYearId: "y1",
  lessonId: null,
  className: "7A",
  subjectName: "Matematik",
  dayOfWeek: 2,
  startMinutes: 540,
  endMinutes: 600,
  rooms: [room({ roomId: "r1", name: "Sal 101", rank: 1 }), room({ roomId: "r2", name: "Sal 102", rank: 2 }), room({ roomId: "r3", name: "Liten sal", tooSmall: true, allowed: false })],
};
const option = (rank: number, dayOfWeek: number, startMinutes: number) => ({
  rank,
  dayOfWeek,
  startMinutes,
  endMinutes: startMinutes + 60,
  lessons: [],
  roomChanged: false,
  costs: [],
  wishes: { met: 0, avoided: 0 },
  score: 0,
});
const TIMES = {
  academicYearId: "y1",
  subject: { lessonId: null, className: "7A", subjectName: "Matematik", minutes: 60, lessonIds: [], isLocked: false, unplaced: true, current: null },
  stepMinutes: 5,
  options: [option(1, 2, 540), option(2, 4, 600)],
  days: [],
  blockers: {},
} as unknown as PossibleTimes;

/** The gateway's routes: the tray, the times, the rooms and the lay. */
function gateway(over: { tray?: unknown; lay?: (body: Record<string, unknown>) => unknown } = {}) {
  get.mockImplementation(async () => ("tray" in over ? over.tray : TRAY));
  post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
    if (path === "/api/v1/master-lessons/possible-times") return TIMES;
    if (path === "/api/v1/master-lessons/room-choices") return ROOMS;
    if (path === "/api/v1/board-tray/lay") return over.lay ? over.lay(body) : { lesson: { id: "n1", dayOfWeek: 2, startTime: "09:00", endTime: "10:00", roomId: "r1" }, noRoom: false };
    throw new Error(`no route ${path}`);
  });
}

function show(ui: React.ReactElement, locale: "sv" | "en" = "sv") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { view, invalidate };
}
const panel = (over: Partial<React.ComponentProps<typeof TrayPanel>> = {}, locale: "sv" | "en" = "sv") =>
  show(<TrayPanel yearId="y1" revision={1} groupById={groups} subjectById={subjects} teacherById={teachers} writable onClose={vi.fn()} {...over} />, locale);

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});
afterEach(cleanup);

describe("the head of Att lägga", () => {
  it("is a button that says how many bricks are left, and the lessons that are laid of those the year asks for", async () => {
    gateway();
    const onToggle = vi.fn();
    show(<TrayHead yearId="y1" revision={1} open={false} onToggle={onToggle} />);
    expect(screen.getByRole("button", { name: /Att lägga/ })).toHaveAttribute("aria-expanded", "false");
    expect(await screen.findByText("35 av 40 lektioner lagda")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Att lägga/ })).toHaveTextContent("5");
    fireEvent.click(screen.getByRole("button", { name: /Att lägga/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/v1/board-tray?academicYearId=y1");
  });

  it("says the förläggningar apart, and is pressed when the panel is open", async () => {
    gateway({ tray: { ...TRAY, tally: { ...TRAY.tally, placedByRow: 4 } } });
    show(<TrayHead yearId="y1" revision={1} open onToggle={vi.fn()} />);
    expect(await screen.findByText("35 av 40 lektioner lagda, 4 förlagda")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Att lägga/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("says the same in English, and draws no figure for an answer that is not the gateway's", async () => {
    gateway();
    const { view } = show(<TrayHead yearId="y1" revision={1} open={false} onToggle={vi.fn()} />, "en");
    expect(await screen.findByText("35 of 40 lessons placed")).toBeInTheDocument();
    view.unmount();
    gateway({ tray: { nonsense: true } });
    show(<TrayHead yearId="y1" revision={2} open={false} onToggle={vi.fn()} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/lektioner lagda/)).toBeNull();
    expect(screen.getByRole("button", { name: /Att lägga/ })).not.toHaveTextContent("5");
  });
});

describe("the panel of Att lägga", () => {
  it("lists the bricks in the gateway's order, each with its class, subject, teacher, length and weeks, and what is the matter with the ones that wait", async () => {
    gateway();
    panel();
    const list = await screen.findByRole("list", { name: "5 brickor" });
    const rows = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(rows[0]).toContain("Matematik 7A");
    expect(rows[0]).toContain("Anna Ek, 60 min, varje vecka");
    expect(rows[2]).toContain("Svenska 7B");
    expect(rows[2]).toContain("Bo Lind, 45 min, udda veckor");
    expect(rows[2]).toContain("På parkeringen");
    expect(rows[3]).toContain("ingen lärare");
    expect(rows[3]).toContain("Saknar lärare");
    expect(rows[4]).toContain("Läggs med blocket");
  });

  it("offers Lägg for the bricks that can be laid alone, and not for a block's or one nobody teaches", async () => {
    gateway();
    panel();
    await screen.findByRole("list");
    expect(screen.getAllByRole("button", { name: /^Lägg Matematik 7A/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Lägg Svenska 7B" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lägg Svenska 7A" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Lägg / })).toHaveLength(3);
  });

  it("shows a reader of the grundschema the tray and no Lägg", async () => {
    gateway();
    panel({ writable: false });
    await screen.findByRole("list");
    expect(screen.queryByRole("button", { name: /^Lägg / })).toBeNull();
  });

  it("filters by class, with each class's count beside its name, in name order, and leaves out a class with nothing left", async () => {
    gateway();
    panel();
    await screen.findByRole("list");
    const select = screen.getByRole("combobox", { name: "Klass" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["Alla klasser (5)", "7A (3)", "7B (2)"]);
    fireEvent.change(select, { target: { value: "g2" } });
    expect(screen.getByRole("list", { name: "2 brickor" })).toBeInTheDocument();
    expect(screen.queryByText("Matematik 7A")).toBeNull();
  });

  it("says everything is laid when no brick is left, and tells the way on when the answer is not the gateway's", async () => {
    gateway({ tray: { ...TRAY, bricks: [], groups: [], tally: { lessons: 40, laid: 40, placedByRow: 0, left: 0 } } });
    const first = panel();
    expect(await screen.findByText("Allt är lagt: ingen lektion saknas i grundschemat.")).toBeInTheDocument();
    first.view.unmount();
    gateway({ tray: { nonsense: true } });
    panel({ revision: 2 });
    expect(await screen.findByText("Det gick inte att hämta brickorna.")).toBeInTheDocument();
    gateway();
    fireEvent.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("list")).toBeInTheDocument();
  });

  it("closes from its own button", async () => {
    gateway();
    const onClose = vi.fn();
    panel({ onClose });
    await screen.findByRole("list");
    fireEvent.click(screen.getByRole("button", { name: "Stäng Att lägga" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says the same in English", async () => {
    gateway();
    panel({}, "en");
    expect(await screen.findByRole("list", { name: "5 bricks" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Place Matematik 7A" })).toHaveLength(2);
    expect(screen.getByText(/Bo Lind, 45 min, odd weeks/)).toBeInTheDocument();
  });
});

describe("laying a brick", () => {
  async function open(name = "Lägg Matematik 7A") {
    gateway();
    const view = panel();
    await screen.findByRole("list");
    fireEvent.click(screen.getAllByRole("button", { name: new RegExp(`^${name}`) })[0]!);
    return view;
  }

  it("asks the gateway for the brick's best times and the rooms, by what is known of the brick, and offers them as buttons", async () => {
    await open();
    expect(await screen.findByRole("button", { name: /1\. Tisdag 09:00–10:00/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2\. Torsdag 10:00–11:00/ })).toBeInTheDocument();
    const brickSubject = { academicYearId: "y1", studentGroupId: "g1", subjectId: "s1", minutes: 60, teacherId: "t1", recurrence: "ALL_WEEKS" };
    expect(post).toHaveBeenCalledWith("/api/v1/master-lessons/possible-times", expect.objectContaining({ brick: brickSubject }), expect.anything());
  });

  it("fills the day and the start with a time that is chosen, asks the rooms for it, and puts the room the generator ranks first in the field", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: /2\. Torsdag/ }));
    expect(screen.getByRole("combobox", { name: "Dag" })).toHaveValue("4");
    expect(screen.getByRole("textbox", { name: /Start/ })).toHaveValue("10:00");
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/master-lessons/room-choices", expect.objectContaining({ dayOfWeek: 4, startTime: "10:00", brick: expect.anything() }), expect.anything()));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("r1"));
    expect(within(screen.getByRole("combobox", { name: "Sal" })).getAllByRole("option").map((entry) => entry.textContent)).toEqual([
      "Utan sal",
      "Sal 101: ledig, förslag 1",
      "Sal 102: ledig, förslag 2",
      "Liten sal: ledig, för liten",
    ]);
  });

  it("lays the brick where it is put, with the room that was chosen, says it in a toast, and reads the tray and the grundschema again", async () => {
    const { invalidate } = await open();
    fireEvent.click(await screen.findByRole("button", { name: /1\. Tisdag/ }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("r1"));
    fireEvent.change(screen.getByRole("combobox", { name: "Sal" }), { target: { value: "r2" } });
    fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/board-tray/lay", {
      academicYearId: "y1",
      postId: "p1",
      teacherId: "t1",
      minutes: 60,
      partKey: "0123456789abcdef",
      dayOfWeek: 2,
      startTime: "09:00",
      roomId: "r2",
    });
    expect(toast.success).toHaveBeenCalledWith("Lagd och låst: Matematik 7A Tisdag 09:00–10:00");
    for (const key of ["boardTray", "masterLessons", "calendarLessons", "teacherLessons"]) expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    // The form is gone, and the focus is on the panel's heading, not lost.
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByRole("heading", { name: "Att lägga" })).toHaveFocus();
  });

  it("lays without a room when none is chosen, and says so", async () => {
    gateway({ lay: () => ({ lesson: { id: "n1", dayOfWeek: 1, startTime: "08:00", endTime: "09:00", roomId: null }, noRoom: true }) });
    panel();
    await screen.findByRole("list");
    fireEvent.click(screen.getAllByRole("button", { name: /^Lägg Matematik 7A/ })[0]!);
    fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "08:00" } });
    fireEvent.change(await screen.findByRole("combobox", { name: "Sal" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Lagd och låst, utan sal: Matematik 7A Måndag 08:00–09:00"));
    expect(post).toHaveBeenCalledWith("/api/v1/board-tray/lay", expect.objectContaining({ roomId: null, dayOfWeek: 1, startTime: "08:00" }));
  });

  it("lays without a room when Utan sal is chosen after the room the generator ranks first has come into the field", async () => {
    gateway({ lay: () => ({ lesson: { id: "n1", dayOfWeek: 2, startTime: "09:00", endTime: "10:00", roomId: null }, noRoom: true }) });
    panel();
    await screen.findByRole("list");
    fireEvent.click(screen.getAllByRole("button", { name: /^Lägg Matematik 7A/ })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: /1\. Tisdag/ }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("r1"));
    fireEvent.change(screen.getByRole("combobox", { name: "Sal" }), { target: { value: "" } });
    expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Lagd och låst, utan sal: Matematik 7A Tisdag 09:00–10:00"));
    expect(post).toHaveBeenCalledWith("/api/v1/board-tray/lay", expect.objectContaining({ roomId: null }));
  });

  it("does not lay before the start is a clock", async () => {
    await open();
    const lay = screen.getByRole("button", { name: "Lägg" });
    expect(lay).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "25:00" } });
    expect(lay).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "09:15" } });
    // A clock is not all it waits for: the rooms of that time are asked for first (see "while the rooms of the time are on their way").
    await waitFor(() => expect(lay).toBeEnabled());
  });

  it("names the lesson on the parking when the brick is one, so that it is moved back and no new lesson is made", async () => {
    await open("Lägg Svenska 7B");
    fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "13:00" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/board-tray/lay", expect.objectContaining({ lessonId: "l9", postId: "p2", teacherId: "t2", minutes: 45, partKey: "aaaaaaaaaaaaaaaa" })));
  });

  describe("while the rooms of the time are on their way", () => {
    /** The gateway as above, with the answer to the room question held back until the test lets it go. */
    function holdRooms(answer: "later" | "fails") {
      gateway();
      const original = post.getMockImplementation()!;
      let release: (value: unknown) => void = () => {};
      post.mockImplementation((path: string, body: Record<string, unknown>, ...rest: unknown[]) => {
        if (path !== "/api/v1/master-lessons/room-choices") return original(path, body, ...rest);
        return answer === "fails" ? Promise.reject(new ApiError(500, "boom", "SOMETHING")) : new Promise((resolve) => (release = resolve));
      });
      return { release: (value: unknown) => release(value) };
    }
    async function openWithStart() {
      panel();
      await screen.findByRole("list");
      fireEvent.click(screen.getAllByRole("button", { name: /^Lägg Matematik 7A/ })[0]!);
      fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "09:00" } });
      await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/master-lessons/room-choices", expect.anything(), expect.anything()));
    }

    it("does not lay until they have come, so that a quick press does not lay without the room the generator ranks first", async () => {
      const rooms = holdRooms("later");
      await openWithStart();
      expect(screen.getByRole("button", { name: "Lägg" })).toBeDisabled();
      expect(screen.getByText("Hämtar salarna …")).toBeInTheDocument();
      fireEvent.submit(screen.getByRole("form", { name: "Lägg Matematik 7A" }));
      expect(post).not.toHaveBeenCalledWith("/api/v1/board-tray/lay", expect.anything());

      rooms.release(ROOMS);
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("r1"));
      expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled();
      expect(screen.queryByText("Hämtar salarna …")).toBeNull();
    });

    it("lets the reader lay at once without a room, by choosing Utan sal before they have come", async () => {
      holdRooms("later");
      await openWithStart();
      fireEvent.change(screen.getByRole("combobox", { name: "Sal" }), { target: { value: "" } });
      expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
      await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/board-tray/lay", expect.objectContaining({ roomId: null })));
    });

    it("says it when they could not be read, and lays without a room then: nothing is waited for that will not come", async () => {
      holdRooms("fails");
      await openWithStart();
      expect(await screen.findByText(/Salarna gick inte att hämta/)).toBeInTheDocument();
      expect(screen.queryByText("Hämtar salarna …")).toBeNull();
      expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled();
    });

    it("waits again for the rooms of another time, and does not lay with a room that belongs to the time before", async () => {
      gateway();
      panel();
      await screen.findByRole("list");
      fireEvent.click(screen.getAllByRole("button", { name: /^Lägg Matematik 7A/ })[0]!);
      fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "09:00" } });
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("r1"));
      fireEvent.change(screen.getByRole("combobox", { name: "Sal" }), { target: { value: "r2" } });
      fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "10:00" } });
      expect(screen.getByRole("button", { name: "Lägg" })).toBeDisabled();
      await waitFor(() => expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled());
    });
  });

  it("cancels, and leaves the brick on the tray", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(screen.queryByRole("form")).toBeNull();
    expect(post).not.toHaveBeenCalledWith("/api/v1/board-tray/lay", expect.anything());
  });

  it("puts the focus back on the button that opened the form when it is cancelled, not on the top of a list that may be forty bricks long", async () => {
    await open("Lägg Svenska 7B");
    expect(screen.getByRole("button", { name: "Lägg Svenska 7B" })).toHaveAttribute("aria-expanded", "true");
    screen.getByRole("button", { name: "Avbryt" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "Avbryt" }));
    expect(screen.getByRole("button", { name: "Lägg Svenska 7B" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Lägg Svenska 7B" })).toHaveAttribute("aria-expanded", "false");
  });

  describe("when the gateway says no", () => {
    const refuse = (error: ApiError) => {
      gateway({
        lay: () => {
          throw error;
        },
      });
    };
    async function layAt() {
      const view = panel();
      await screen.findByRole("list");
      fireEvent.click(screen.getAllByRole("button", { name: /^Lägg Matematik 7A/ })[0]!);
      fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "09:00" } });
      await waitFor(() => expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled());
      fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
      return view;
    }

    it("reads the tray again and says so when somebody else changed the part: the picture the brick was read in is not the part's now", async () => {
      refuse(new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_STALE"));
      const { invalidate } = await layAt();
      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(toast.error.mock.calls[0]![0]).toMatch(/Någon annan har lagt eller ändrat/);
      expect(screen.queryByRole("form")).toBeNull();
      // The tray is asked for again: the list on the page is the picture the lay was refused on, and a second press would be refused the same way.
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["boardTray"] });
      await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    it("says why a room does not suit, and lays without a room when that is answered", async () => {
      refuse(new ApiError(409, "x", "BOARD_ROOM_NOT_ALLOWED", { roomId: "r1", reason: "SEATS" }));
      await layAt();
      expect(await screen.findByText(/Salen har för få platser för lektionen/)).toBeInTheDocument();
      gateway();
      fireEvent.click(screen.getByRole("button", { name: "Lägg utan sal" }));
      await waitFor(() => expect(post).toHaveBeenLastCalledWith("/api/v1/board-tray/lay", expect.objectContaining({ roomId: null })));
    });

    it("lays without a room when the room in the field is the one the gateway refused, and not with it again", async () => {
      const lays: unknown[] = [];
      gateway({
        lay: (body) => {
          lays.push(body["roomId"]);
          if (body["roomId"] !== null) throw new ApiError(409, "x", "BOARD_ROOM_NOT_ALLOWED", { roomId: "r1", reason: "TYPE" });
          return { lesson: { id: "n1", dayOfWeek: 2, startTime: "09:00", endTime: "10:00", roomId: null }, noRoom: true };
        },
      });
      panel();
      await screen.findByRole("list");
      fireEvent.click(screen.getAllByRole("button", { name: /^Lägg Matematik 7A/ })[0]!);
      fireEvent.click(await screen.findByRole("button", { name: /1\. Tisdag/ }));
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("r1"));
      fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
      expect(await screen.findByText(/Salen är inte den typ ämnet kräver/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Lägg utan sal" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
      expect(lays).toEqual(["r1", null]);
    });

    it("gives the gateway's sentence for a time the judge refuses, and offers Lägg ändå only when every rule it names can be answered yes to", async () => {
      refuse(new ApiError(409, "Matematik 7A: Tiden ligger utanför ramtiden.", "MASTER_LESSON_REFUSED", { reason: "FRAME", reasons: "FRAME" }));
      await layAt();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      gateway();
      fireEvent.click(screen.getByRole("button", { name: "Lägg ändå" }));
      await waitFor(() => expect(post).toHaveBeenLastCalledWith("/api/v1/board-tray/lay", expect.objectContaining({ exempt: ["FRAME"] })));
    });

    it("answers Lägg ändå without the room that was refused: a time that is both outside the frame and in a room that does not suit is laid by two answers, not by two answers that undo each other", async () => {
      const lays: Array<{ roomId: unknown; exempt: unknown }> = [];
      gateway({
        lay: (body) => {
          lays.push({ roomId: body["roomId"], exempt: body["exempt"] });
          // The gateway asks the room first and the judge second.
          if (body["roomId"] !== null) throw new ApiError(409, "x", "BOARD_ROOM_NOT_ALLOWED", { roomId: "r1", reason: "SEATS" });
          if (body["exempt"] === undefined) throw new ApiError(409, "Matematik 7A: Tiden ligger utanför ramtiden.", "MASTER_LESSON_REFUSED", { reason: "FRAME", reasons: "FRAME" });
          return { lesson: { id: "n1", dayOfWeek: 2, startTime: "09:00", endTime: "10:00", roomId: null }, noRoom: true };
        },
      });
      panel();
      await screen.findByRole("list");
      fireEvent.click(screen.getAllByRole("button", { name: /^Lägg Matematik 7A/ })[0]!);
      fireEvent.click(await screen.findByRole("button", { name: /1\. Tisdag/ }));
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("r1"));
      fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
      fireEvent.click(await screen.findByRole("button", { name: "Lägg utan sal" }));
      // The room field says what is laid: none.
      expect(await screen.findByRole("button", { name: "Lägg ändå" })).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "Sal" })).toHaveValue("");
      fireEvent.click(screen.getByRole("button", { name: "Lägg ändå" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
      expect(lays).toEqual([
        { roomId: "r1", exempt: undefined },
        { roomId: null, exempt: undefined },
        { roomId: null, exempt: ["FRAME"] },
      ]);
    });

    it("takes the refusal away when the reader changes what it was about: the time, the day or the room", async () => {
      refuse(new ApiError(409, "Matematik 7A: Tiden ligger utanför ramtiden.", "MASTER_LESSON_REFUSED", { reason: "FRAME", reasons: "FRAME" }));
      await layAt();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Lägg ändå" })).toBeInTheDocument();
      fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "08:00" } });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: "Lägg ändå" })).toBeNull();
      // The same for the day and for the room: each press that is refused shows the refusal, and each change takes it away.
      for (const [name, value] of [["Dag", "3"], ["Sal", "r2"]] as const) {
        await waitFor(() => expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled());
        fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
        expect(await screen.findByRole("alert")).toBeInTheDocument();
        fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
        expect(screen.queryByRole("alert")).toBeNull();
      }
    });

    it("offers no Lägg ändå for a time that breaks a rule that cannot be exempted", async () => {
      refuse(new ApiError(409, "Läraren har en annan lektion.", "MASTER_LESSON_REFUSED", { reason: "TEACHER", reasons: "TEACHER,FRAME" }));
      await layAt();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Lägg ändå" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Lägg utan sal" })).toBeNull();
    });

    it("keeps the form and says it for anything else, so that nothing is lost", async () => {
      refuse(new ApiError(500, "boom", "SOMETHING"));
      await layAt();
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("form", { name: "Lägg Matematik 7A" })).toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
    });
  });
});

describe("in Direkt, where the school is asked before a change that reaches families (P5, beslut 8)", () => {
  class Declined extends Error {
    constructor() {
      super("DIRECT_REACH_DECLINED");
      this.name = "DirectReachDeclined";
    }
  }
  const isDeclined = (error: unknown) => error instanceof Declined;
  async function layWith(guard: <T>(run: () => Promise<T>) => Promise<T>) {
    gateway();
    panel({ guard, declined: isDeclined });
    await screen.findByRole("list");
    fireEvent.click(screen.getByRole("button", { name: "Lägg Svenska 7B" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Start/ }), { target: { value: "13:00" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Lägg" }));
  }

  it("lays inside the page's question, once, and asks it of nothing else the form does", async () => {
    const guard = vi.fn((run: () => Promise<unknown>) => run());
    await layWith(guard as never);
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/api/v1/board-tray/lay", expect.objectContaining({ lessonId: "l9" }));
  });

  it("does not lay when the reader answers no to the question, and says no failure: the form stays as it was", async () => {
    const guard = vi.fn(async () => {
      throw new Declined();
    });
    await layWith(guard as never);
    await waitFor(() => expect(guard).toHaveBeenCalledTimes(1));
    expect(post).not.toHaveBeenCalledWith("/api/v1/board-tray/lay", expect.anything());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.getByRole("form", { name: "Lägg Svenska 7B" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lägg" })).toBeEnabled();
  });

  it("says an error of the question's own that is not a no", async () => {
    await layWith((async () => {
      throw new ApiError(500, "boom", "SOMETHING");
    }) as never);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});
