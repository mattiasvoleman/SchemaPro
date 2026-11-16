import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { TeachingBlock, TeachingRequirement } from "@/lib/types";
import { BlockPlacementDialog } from "./block-placement-dialog";

/**
 * Förlägg blocket. What the gateway judges, stores and refuses is its own specs' (block-placements.service.spec.ts); here the
 * GET is answered, the PUT recorded and answered, and the dialog is held to what it offers (only what the block can be saved
 * with), what it shows of the verdicts it was given, what it sends, and where it says a refusal.
 */

const state = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  rooms: [] as { id: string; name: string }[],
  roomsFailed: false,
  /** Keys whose real sentence a test wants (an echoed key cannot be told from the words around it). */
  sentences: {} as Record<string, string>,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: state.get, put: state.put },
}));
vi.mock("@/lib/queries", () => ({
  useRooms: () => ({ data: state.roomsFailed ? undefined : state.rooms, isError: state.roomsFailed }),
}));
vi.mock("sonner", () => ({ toast: { success: state.success, error: state.error } }));
// Keys echoed with their values: the sentences are i18n/placements-messages.test.ts's.
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values && state.sentences[key]
          ? state.sentences[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]))
          : values
            ? `${key}(${Object.values(values).join("|")})`
            : key,
      { has: () => true },
    ),
}));

const BLOCK: TeachingBlock = { id: "b-sv", academicYearId: "y1", name: "Språkval åk 7", sameTimesAsBlockId: null };

const post = (id: string, extra: Partial<TeachingRequirement> = {}) =>
  ({
    id,
    academicYearId: "y1",
    subjectId: `s-${id}`,
    studentGroupId: `g-${id}`,
    teacherId: `t-${id}`,
    coTeacherId: null,
    lessonsPerWeek: 3,
    minutesPerLesson: 80,
    lessonLengths: [80, 40, 40],
    minutesBefore: 0,
    minutesAfter: 0,
    teacherLoadPercent: 100,
    coTeacherLoadPercent: 100,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    blockId: BLOCK.id,
    ...extra,
  }) as TeachingRequirement;

const MEMBERS = [post("r-ty"), post("r-fr"), post("r-sp")];
const NAMES: Record<string, string> = { "r-ty": "Tyska för Ty7", "r-fr": "Franska för Fr7", "r-sp": "Spanska för Sp7" };
const label = (requirement: TeachingRequirement) => NAMES[requirement.id] ?? requirement.id;

const stored = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `p${n}`,
  blockId: BLOCK.id,
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:20",
  minutes: 80,
  recurrence: "ALL_WEEKS",
  rooms: [],
  ...extra,
});

/** The GET: the block's lessons, a verdict for each lesson and post (holding unless a test says), and the block's lengths. */
function answer(placements: ReturnType<typeof stored>[], verdicts?: unknown[], lengths: number[] = [80, 40, 40], rowsKey = "key-1") {
  state.get.mockResolvedValue({
    placements,
    verdicts:
      verdicts ??
      placements.flatMap((_, index) => MEMBERS.map((member) => ({ index, requirementId: member.id, ok: true }))),
    rowsKey,
    lengths,
  });
}

function renderDialog(
  props: { block?: TeachingBlock; members?: readonly TeachingRequirement[]; followedName?: string | null } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <BlockPlacementDialog
        open
        onOpenChange={onOpenChange}
        block={props.block ?? BLOCK}
        members={props.members ?? MEMBERS}
        label={label}
        followedName={props.followedName}
      />
    </QueryClientProvider>,
  );
  return { invalidate, onOpenChange, user: userEvent.setup() };
}

/** The dialog once its lessons have been read. */
async function opened(props: Parameters<typeof renderDialog>[0] = {}) {
  const rendered = renderDialog(props);
  // The line that counts the lessons is drawn once they have been read.
  await screen.findByText(/^summary\(/);
  return rendered;
}

/** The lessons, each a fieldset with a legend of its own (the one around them has none). */
const rowsOf = () => screen.queryAllByRole("group").filter((group) => group.querySelector(":scope > legend") !== null);
const rowNamed = (n: number) => screen.getByRole("group", { name: new RegExp(`rowTitle\\(${n}\\)`) });
const saveButton = () => screen.getByRole("button", { name: "save" });
const field = (row: HTMLElement, name: string) => within(row).getByLabelText(name) as HTMLSelectElement;
const roomOf = (row: HTMLElement, requirementId: string) => field(row, `roomOf(${NAMES[requirementId]})`);

beforeEach(() => {
  state.get.mockReset();
  state.put.mockReset().mockResolvedValue({ placements: [], verdicts: [], rowsKey: "key-2", lengths: [80, 40, 40] });
  state.success.mockReset();
  state.error.mockReset();
  state.roomsFailed = false;
  state.sentences = {};
  // Out of order on purpose: the dialog lists them by name.
  state.rooms = [
    { id: "room-gym", name: "Gymnastiksalen" },
    { id: "room-aula", name: "Aulan" },
    { id: "room-sim", name: "Simhallen" },
  ];
  answer([]);
});

describe("the dialog", () => {
  it("is named after the block and reads the block's own lessons when it opens", async () => {
    answer([stored(1)]);
    await opened();

    expect(screen.getByRole("dialog", { name: "title(Språkval åk 7)" })).toBeInTheDocument();
    expect(state.get).toHaveBeenCalledWith("/api/v1/teaching-blocks/b-sv/placements");
  });

  it("counts the block's lessons by length and how many of them are placed, in a line a reader hears change", async () => {
    answer([stored(1)]);
    await opened();

    const line = screen.getByText(/^summary\(/);
    expect(line).toHaveTextContent("summary(lengthPart(1|80) och lengthPart(2|40)|1|3)");
    expect(line).toHaveAttribute("aria-live", "polite");
  });

  it("draws one labelled lesson for each that is placed, with the day, the start and the length", async () => {
    answer([stored(1), stored(2, { dayOfWeek: 4, startTime: "13:15", endTime: "13:55", minutes: 40 })]);
    await opened();

    expect(rowsOf()).toHaveLength(2);
    const first = rowNamed(1);
    expect(field(first, "day").value).toBe("2");
    expect(field(first, "start").value).toBe("10:00");
    expect(field(first, "length").value).toBe("80");
    const second = rowNamed(2);
    expect(field(second, "day").value).toBe("4");
    expect(field(second, "start").value).toBe("13:15");
    expect(field(second, "length").value).toBe("40");
  });

  it("says the block's weeks as text and does not ask for them", async () => {
    answer([stored(1)]);
    await opened();

    const row = rowNamed(1);
    expect(within(row).getByText("weeksAll")).toBeInTheDocument();
    expect(within(row).queryByLabelText("weeks")).toBeNull();
  });

  it("says the weeks of a block that runs odd weeks only", async () => {
    answer([stored(1, { recurrence: "ODD_WEEKS" })]);
    await opened({ members: MEMBERS.map((member) => ({ ...member, recurrence: "ODD_WEEKS" }) as TeachingRequirement) });

    expect(within(rowNamed(1)).getByText("weeksOdd")).toBeInTheDocument();
  });

  it("offers Monday to Friday", async () => {
    answer([stored(1)]);
    await opened();

    expect([...field(rowNamed(1), "day").options].map((option) => option.value)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("takes the time in five-minute steps, and says when the lesson ends", async () => {
    answer([stored(1)]);
    await opened();

    const start = field(rowNamed(1), "start");
    expect(start).toHaveAttribute("type", "time");
    expect(start).toHaveAttribute("step", "300");
    expect(screen.getByText("ends(11:20)")).toBeInTheDocument();
  });

  it("says that a change applies at the next Generate, that a placed lesson is changed here and not on the card, and that it never gives way", async () => {
    await opened();

    expect(screen.getByText("nextGenerate")).toBeInTheDocument();
    expect(screen.getByText("handMove")).toBeInTheDocument();
    expect(screen.getByText("neverGivesWay")).toBeInTheDocument();
  });

  it("says that an empty room is the engine's to choose, once, and ties each post's room to it", async () => {
    answer([stored(1), stored(2, { dayOfWeek: 4 })]);
    await opened();

    const hint = screen.getByText("roomsHint");
    expect(screen.getAllByText("roomsHint")).toHaveLength(1);
    for (const row of [rowNamed(1), rowNamed(2)]) {
      for (const member of MEMBERS) expect(roomOf(row, member.id).getAttribute("aria-describedby")).toContain(hint.id);
    }
  });

  it("says the lessons could not be read, and offers nothing to save over them", async () => {
    state.get.mockRejectedValue(new ApiError(500, "boom"));
    renderDialog();

    expect(await screen.findByText("loadFailed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
    expect(saveButton()).toBeDisabled();
  });

  it("says the rooms could not be read, instead of offering none", async () => {
    state.roomsFailed = true;
    answer([stored(1)]);
    await opened();

    expect(screen.getByText("roomsFailed")).toBeInTheDocument();
  });
});

describe("a room for each post", () => {
  it("is asked of every post of the block by its name, in the order the page lists them, with the engine's choice first", async () => {
    answer([stored(1)]);
    await opened();

    const row = rowNamed(1);
    const rooms = within(row)
      .getAllByRole("combobox")
      .filter((select) => select.getAttribute("id")?.includes("-room-"));
    expect(rooms.map((select) => (select as HTMLSelectElement).labels?.[0]?.textContent)).toEqual(
      MEMBERS.map((member) => `roomOf(${NAMES[member.id]})`),
    );
    for (const member of MEMBERS) {
      // The empty choice comes first, then the school's rooms by name.
      expect([...roomOf(row, member.id).options].map((option) => option.textContent)).toEqual([
        "roomAny",
        "Aulan",
        "Gymnastiksalen",
        "Simhallen",
      ]);
      expect(roomOf(row, member.id).value).toBe("");
    }
  });

  it("opens a stored lesson on the rooms its posts chose, and leaves the others on the engine's choice", async () => {
    answer([
      stored(1, { rooms: [{ requirementId: "r-ty", roomId: "room-aula", roomName: "Aulan" }, { requirementId: "r-sp", roomId: "room-sim", roomName: "Simhallen" }] }),
    ]);
    await opened();

    const row = rowNamed(1);
    expect(roomOf(row, "r-ty").value).toBe("room-aula");
    expect(roomOf(row, "r-fr").value).toBe("");
    expect(roomOf(row, "r-sp").value).toBe("room-sim");
  });

  it("keeps a room the list no longer offers, as stored", async () => {
    answer([stored(1, { rooms: [{ requirementId: "r-ty", roomId: "room-gone", roomName: "Gamla salen" }] })]);
    await opened();

    expect(roomOf(rowNamed(1), "r-ty").value).toBe("room-gone");
    expect(within(roomOf(rowNamed(1), "r-ty")).getByRole("option", { name: "Gamla salen" })).toBeInTheDocument();
  });

  it("is chosen for one post alone, and the posts left on the engine's choice are not sent with a room", async () => {
    const { user, onOpenChange } = await opened();
    await user.click(screen.getByRole("button", { name: "add" }));
    fireEvent.change(field(rowNamed(1), "start"), { target: { value: "09:05" } });
    await user.selectOptions(roomOf(rowNamed(1), "r-fr"), "room-aula");

    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(state.put).toHaveBeenCalledWith("/api/v1/teaching-blocks/b-sv/placements", {
      placements: [{ dayOfWeek: 1, startTime: "09:05", minutes: 80, rooms: [{ requirementId: "r-fr", roomId: "room-aula" }] }],
      baseKey: "key-1",
    });
  });

  it("sends a lesson with no room for any post with an empty list of rooms, and takes a room back to the empty choice", async () => {
    answer([stored(1, { rooms: [{ requirementId: "r-ty", roomId: "room-aula", roomName: "Aulan" }] })]);
    const { user } = await opened();

    await user.selectOptions(roomOf(rowNamed(1), "r-ty"), "");
    await user.click(saveButton());

    await waitFor(() => expect(state.put).toHaveBeenCalled());
    expect(state.put.mock.calls[0]![1].placements[0].rooms).toEqual([]);
  });

  it("offers the engine's choice as a choice a reader can make from the list: an option that is not hidden, and chosen by what it says (review of #328, LÅG-2)", async () => {
    answer([stored(1, { rooms: [{ requirementId: "r-ty", roomId: "room-aula", roomName: "Aulan" }] })]);
    const { user } = await opened();
    const select = roomOf(rowNamed(1), "r-ty");

    // Found as a reader finds it (by role, which leaves out what is hidden), never by its text or its value alone: a `hidden` option
    // keeps both and is not offered by a browser's list, so a post whose room was chosen could not go back to the engine's choice.
    const any = within(select).getByRole("option", { name: "roomAny" });
    expect(any).toBeVisible();
    expect(any).not.toHaveAttribute("hidden");
    expect(select.value).toBe("room-aula");

    await user.selectOptions(select, any);

    expect(select.value).toBe("");
    expect(within(select).getByRole("option", { name: "roomAny", selected: true })).toBe(any);
    expect(within(roomOf(rowNamed(1), "r-fr")).getByRole("option", { name: "roomAny", selected: true })).toBeVisible();
  });

  it("sends each post's room in the order the posts are listed, whichever was chosen first", async () => {
    answer([stored(1)]);
    const { user } = await opened();

    await user.selectOptions(roomOf(rowNamed(1), "r-sp"), "room-sim");
    await user.selectOptions(roomOf(rowNamed(1), "r-ty"), "room-gym");
    await user.click(saveButton());

    await waitFor(() => expect(state.put).toHaveBeenCalled());
    expect(state.put.mock.calls[0]![1].placements[0].rooms).toEqual([
      { requirementId: "r-ty", roomId: "room-gym" },
      { requirementId: "r-sp", roomId: "room-sim" },
    ]);
  });
});

describe("a name of one long word (review of #328, LÅG-2)", () => {
  // jsdom has no layout, so what is held here is that the words that can be long are allowed to break inside the word; where they
  // stand at 320 px is e2e/block-placement.smoke.spec.ts's, measured in a browser.
  const LONG = "Språkvalsblockförårskursenmedmodernaspråkochannatval";

  it("lets the title, the labels and the sentences about a lesson break inside a word", async () => {
    answer([stored(1)], MEMBERS.map((member) => ({ index: 0, requirementId: member.id, ok: false, reason: "TEACHER" })));
    await opened({ block: { ...BLOCK, name: LONG } });

    const title = screen.getByRole("heading", { name: `title(${LONG})` });
    expect(title).toHaveClass("break-words");
    const row = rowNamed(1);
    // Every label of a lesson (the day, the length, the start and the rooms) is allowed to break inside a word.
    expect(row.className).toContain("[&_label]:break-words");
    expect(within(row).getAllByText(/^(day|start|length|roomOf\(.*\))$/).length).toBeGreaterThan(0);
    for (const sentence of row.querySelectorAll("p.text-destructive")) expect(sentence).toHaveClass("break-words");
    expect(row.querySelectorAll("p.text-destructive").length).toBeGreaterThan(0);
  });
});

describe("the length", () => {
  it("is asked among the block's own lengths when it has several", async () => {
    answer([stored(1)]);
    await opened();

    expect([...field(rowNamed(1), "length").options].map((option) => option.value)).toEqual(["80", "40"]);
  });

  it("is said, and not asked, when the block has only one", async () => {
    answer([stored(1, { minutes: 60, endTime: "11:00" })], undefined, [60, 60]);
    await opened({ members: MEMBERS.map((member) => ({ ...member, lessonLengths: [], lessonsPerWeek: 2, minutesPerLesson: 60 }) as TeachingRequirement) });

    expect(within(rowNamed(1)).queryByLabelText("length")).toBeNull();
    expect(within(rowNamed(1)).getByText("minutes(60)")).toBeInTheDocument();
  });

  it("is sent as chosen", async () => {
    answer([stored(1)]);
    const { user } = await opened();

    await user.selectOptions(field(rowNamed(1), "length"), "40");
    await user.click(saveButton());

    await waitFor(() => expect(state.put).toHaveBeenCalled());
    expect(state.put.mock.calls[0]![1].placements[0]).toMatchObject({ minutes: 40 });
  });
});

describe("adding and removing a lesson", () => {
  it("starts a lesson with nothing chosen but the block's longest length, and moves to its first field", async () => {
    const { user } = await opened();

    expect(screen.getByText("empty")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "add" }));

    const row = rowNamed(1);
    expect(field(row, "start").value).toBe("");
    expect(field(row, "length").value).toBe("80");
    for (const member of MEMBERS) expect(roomOf(row, member.id).value).toBe("");
    expect(field(row, "day")).toHaveFocus();
    expect(screen.queryByText("empty")).toBeNull();
  });

  it("offers as many lessons of a length as the block has, longest first, and then no more", async () => {
    const { user } = await opened();
    const add = screen.getByRole("button", { name: "add" });

    await user.click(add);
    await user.click(add);
    await user.click(add);

    // One of 80 and two of 40, in that order.
    expect([1, 2, 3].map((n) => field(rowNamed(n), "length").value)).toEqual(["80", "40", "40"]);
    expect(add).toBeDisabled();
    expect(add.getAttribute("aria-describedby")).toBe(screen.getByText("addFull(3)").id);
  });

  it("offers a length again when a lesson of it is removed, and takes up the one that is left", async () => {
    answer([stored(1), stored(2, { minutes: 40 }), stored(3, { minutes: 40, dayOfWeek: 4 })]);
    const { user } = await opened();
    expect(screen.getByRole("button", { name: "add" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "remove(2)" }));
    expect(screen.getByRole("button", { name: "add" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "add" }));

    expect(field(rowNamed(3), "length").value).toBe("40");
  });

  it("removes a lesson, and the lessons after it move up, with the focus on the add button", async () => {
    answer([stored(1), stored(2, { dayOfWeek: 4 })]);
    const { user } = await opened();

    await user.click(screen.getByRole("button", { name: "remove(1)" }));

    expect(rowsOf()).toHaveLength(1);
    expect(field(rowNamed(1), "day").value).toBe("4");
    expect(screen.getByRole("button", { name: "add" })).toHaveFocus();
  });

  it("says that saving an emptied list removes the placements, and sends it empty", async () => {
    answer([stored(1)]);
    const { user, onOpenChange, invalidate } = await opened();

    expect(screen.queryByText("emptySave")).toBeNull();
    await user.click(screen.getByRole("button", { name: "remove(1)" }));
    expect(screen.getByText("emptySave")).toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() =>
      expect(state.put).toHaveBeenCalledWith("/api/v1/teaching-blocks/b-sv/placements", { placements: [], baseKey: "key-1" }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["requirementPlacements"] });
    expect(state.success).toHaveBeenCalledWith("saved");
  });
});

describe("saving", () => {
  it("sends the whole list as the gateway takes it, with the key the lessons were read with", async () => {
    answer([stored(1)], undefined, [80, 40, 40], "the-key-it-read");
    const { user } = await opened();

    await user.selectOptions(field(rowNamed(1), "day"), "3");
    fireEvent.change(field(rowNamed(1), "start"), { target: { value: "09:05" } });
    await user.click(saveButton());

    await waitFor(() => expect(state.put).toHaveBeenCalled());
    expect(state.put).toHaveBeenCalledWith("/api/v1/teaching-blocks/b-sv/placements", {
      placements: [{ dayOfWeek: 3, startTime: "09:05", minutes: 80, rooms: [] }],
      baseKey: "the-key-it-read",
    });
  });

  it("asks for a start that fits the school day before it sends, and moves to the first one", async () => {
    const { user } = await opened();
    await user.click(screen.getByRole("button", { name: "add" }));
    await user.click(screen.getByRole("button", { name: "add" }));

    await user.click(saveButton());

    const first = rowNamed(1);
    const start = field(first, "start");
    expect(state.put).not.toHaveBeenCalled();
    expect(start).toBeInvalid();
    expect(start.getAttribute("aria-describedby")).toContain(within(first).getByText(/^problemStart/).id);
    expect(start).toHaveFocus();
  });

  it.each([
    ["too early", "07:55"],
    ["off the grid", "10:02"],
    ["ending after the school day", "17:30"],
  ])("will not send a start %s", async (_what, time) => {
    answer([stored(1)]);
    const { user } = await opened();

    fireEvent.change(field(rowNamed(1), "start"), { target: { value: time } });
    await user.click(saveButton());

    expect(state.put).not.toHaveBeenCalled();
    expect(field(rowNamed(1), "start")).toBeInvalid();
  });

  it("clears a field's error as soon as the field is changed", async () => {
    const { user } = await opened();
    await user.click(screen.getByRole("button", { name: "add" }));
    await user.click(saveButton());
    expect(within(rowNamed(1)).getByText(/^problemStart/)).toBeInTheDocument();

    fireEvent.change(field(rowNamed(1), "start"), { target: { value: "09:05" } });

    expect(within(rowNamed(1)).queryByText(/^problemStart/)).toBeNull();
  });
});

describe("the verdicts it was given", () => {
  const clash = { otherKind: "LESSON", className: "7B", subjectName: "Matematik", day: 2, start: "10:00", end: "11:00" };
  const holding = (index: number, ids: string[]) => ids.map((requirementId) => ({ index, requirementId, ok: true }));

  it("puts the reason a lesson no longer holds in red at that lesson, after the post it is said of, and says how many lessons do not hold", async () => {
    state.sentences = { postSaid: "{posts}: {sentence}" };
    answer(
      [stored(1), stored(2, { dayOfWeek: 4 })],
      [
        { index: 0, requirementId: "r-ty", ok: false, reason: "TEACHER", params: clash },
        ...holding(0, ["r-fr", "r-sp"]),
        ...holding(1, ["r-ty", "r-fr", "r-sp"]),
      ],
    );
    await opened();

    const first = rowNamed(1);
    const reason = within(first).getByText(/^Tyska för Ty7: verdict\.TEACHER/);
    expect(reason).toHaveClass("text-destructive");
    // Tied to the lesson and to its first field, so it is read with them.
    expect(reason.parentElement!.id).toBeTruthy();
    expect(first.getAttribute("aria-describedby")).toBe(reason.parentElement!.id);
    expect(field(first, "day").getAttribute("aria-describedby")).toBe(reason.parentElement!.id);
    expect(field(first, "day")).toBeInvalid();
    expect(within(rowNamed(2)).queryByText(/verdict\./)).toBeNull();
    expect(screen.getByText("staleTitle(1)")).toBeInTheDocument();
  });

  it("says posts that fail for one reason together, and a different reason on its own line", async () => {
    state.sentences = { postSaid: "{posts}: {sentence}" };
    answer(
      [stored(1)],
      [
        { index: 0, requirementId: "r-ty", ok: false, reason: "SCHOOL_DAY" },
        { index: 0, requirementId: "r-fr", ok: false, reason: "SCHOOL_DAY" },
        { index: 0, requirementId: "r-sp", ok: false, reason: "TEACHER", params: clash },
      ],
    );
    await opened();

    const row = rowNamed(1);
    expect(within(row).getByText(/^Tyska för Ty7 och Franska för Fr7: verdict\.SCHOOL_DAY/)).toBeInTheDocument();
    expect(within(row).getByText(/^Spanska för Sp7: verdict\.TEACHER/)).toBeInTheDocument();
  });

  it("says the posts in the order the dialog lists them, whichever order the gateway sent the verdicts in", async () => {
    state.sentences = { postSaid: "{posts}: {sentence}" };
    answer(
      [stored(1)],
      [
        { index: 0, requirementId: "r-sp", ok: false, reason: "SCHOOL_DAY" },
        { index: 0, requirementId: "r-ty", ok: false, reason: "SCHOOL_DAY" },
        { index: 0, requirementId: "r-fr", ok: false, reason: "SCHOOL_DAY" },
      ],
    );
    await opened();

    expect(within(rowNamed(1)).getByText(/^Tyska för Ty7, Franska för Fr7 och Spanska för Sp7: verdict\.SCHOOL_DAY/)).toBeInTheDocument();
  });

  it("lets go of a verdict once its lesson is changed: it was said of the lesson as it was", async () => {
    answer([stored(1)], [{ index: 0, requirementId: "r-ty", ok: false, reason: "ROOM", params: { ...clash, otherKind: "PLACEMENT" } }]);
    const { user } = await opened();
    expect(screen.getByText(/verdict\.ROOM/)).toBeInTheDocument();

    await user.selectOptions(roomOf(rowNamed(1), "r-ty"), "room-aula");

    expect(screen.queryByText(/verdict\.ROOM/)).toBeNull();
    expect(screen.queryByText("staleTitle(1)")).toBeNull();
  });

  it("says the general sentence for a lesson that fails without a reason, and the one for a block that no longer fits", async () => {
    answer(
      [stored(1), stored(2, { dayOfWeek: 4 })],
      [
        { index: 0, requirementId: "r-ty", ok: false },
        { index: 1, requirementId: "r-ty", ok: false, reason: "BLOCK_FIT", params: { rule: "LENGTH" } },
      ],
    );
    await opened();

    expect(within(rowNamed(1)).getByText(/verdict\.UNKNOWN/)).toBeInTheDocument();
    expect(within(rowNamed(2)).getByText(/verdict\.BLOCK_FIT\(LENGTH\)/)).toBeInTheDocument();
  });

  it("names a post that is no longer in the block, for a verdict that is said of it", async () => {
    answer([stored(1)], [{ index: 0, requirementId: "r-gone", ok: false, reason: "FRAME" }]);
    await opened();

    expect(within(rowNamed(1)).getByText(/^postSaid\(postGone/)).toBeInTheDocument();
  });
});

describe("a refused save", () => {
  const refusedRow = (index: number, requirementId: string) =>
    new ApiError(409, "x", "BLOCK_PLACEMENT_REFUSED", {
      index,
      requirementId,
      reason: "TEACHER",
      otherKind: "LESSON",
      className: "7B",
      subjectName: "Matematik",
      day: 2,
      start: "10:00",
      end: "11:00",
    });

  it("says which post clashes and why, at the lesson the gateway names, moves to it, and writes nothing else", async () => {
    state.sentences = { postSaid: "{posts}: {sentence}" };
    answer([stored(1), stored(2, { dayOfWeek: 4 })]);
    state.put.mockRejectedValue(refusedRow(1, "r-sp"));
    const { user, onOpenChange } = await opened();

    await user.click(saveButton());

    const second = rowNamed(2);
    const reason = await within(second).findByText(/^Spanska för Sp7: verdict\.TEACHER/);
    expect(reason).toHaveClass("text-destructive");
    expect(field(second, "day").getAttribute("aria-describedby")).toBe(reason.parentElement!.id);
    expect(field(second, "day")).toBeInvalid();
    expect(field(second, "day")).toHaveFocus();
    expect(within(rowNamed(1)).queryByText(/verdict\./)).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });

  it("keeps the reason on its lesson when a lesson before it is removed, and drops it when the lesson is changed", async () => {
    answer([stored(1), stored(2, { dayOfWeek: 4 })]);
    state.put.mockRejectedValue(refusedRow(1, "r-fr"));
    const { user } = await opened();
    await user.click(saveButton());
    await screen.findByText(/verdict\.TEACHER/);

    await user.click(screen.getByRole("button", { name: "remove(1)" }));
    // The lesson it was said of is now the first, and still carries it.
    expect(within(rowNamed(1)).getByText(/verdict\.TEACHER/)).toBeInTheDocument();

    await user.selectOptions(field(rowNamed(1), "day"), "5");
    expect(screen.queryByText(/verdict\.TEACHER/)).toBeNull();
  });

  it("says at the top, with the post, when the lesson it names is not in the list", async () => {
    answer([stored(1)]);
    state.put.mockRejectedValue(refusedRow(7, "r-ty"));
    const { user } = await opened();

    await user.click(saveButton());

    const top = (await screen.findByText(/^postSaid\(Tyska för Ty7/)).closest("[tabindex='-1']") as HTMLElement;
    expect(top).toHaveFocus();
    expect(within(top).getByText("notSaved")).toBeInTheDocument();
  });

  it("says at the lesson the gateway names that a length is not the block's, and moves to its length", async () => {
    answer([stored(1)]);
    state.put.mockRejectedValue(new ApiError(409, "x", "BLOCK_PLACEMENTS_DO_NOT_FIT", { reason: "LENGTH", index: 0 }));
    const { user } = await opened();

    await user.click(saveButton());

    const row = rowNamed(1);
    const reason = await within(row).findByText(/^fit\.LENGTH/);
    expect(reason).toHaveClass("text-destructive");
    expect(field(row, "length")).toHaveFocus();
  });

  it("says at the top, and moves there, a rule that names no lesson", async () => {
    answer([stored(1)]);
    state.put.mockRejectedValue(new ApiError(409, "x", "BLOCK_PLACEMENTS_DO_NOT_FIT", { reason: "SHARES" }));
    const { user } = await opened();

    await user.click(saveButton());

    const top = (await screen.findByText(/^fit\.SHARES/)).closest("[tabindex='-1']") as HTMLElement;
    expect(top).toHaveFocus();
    expect(within(top).getByText("notSaved")).toBeInTheDocument();
  });

  it("says that the block has changed, writes nothing, and reads the block again on the reader's word", async () => {
    answer([stored(1)], undefined, [80, 40, 40], "old-key");
    state.put.mockRejectedValue(new ApiError(409, "x", "BLOCK_PLACEMENTS_STALE"));
    const { user, onOpenChange } = await opened();
    expect(state.get).toHaveBeenCalledTimes(1);

    await user.click(saveButton());

    const top = (await screen.findByText("staleBody")).closest("[tabindex='-1']") as HTMLElement;
    expect(top).toHaveFocus();
    expect(within(top).getByText("staleTitle")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    // Another writer has placed two lessons since.
    answer([stored(1), stored(2, { dayOfWeek: 4 })], undefined, [80, 40, 40], "new-key");
    await user.click(within(top).getByRole("button", { name: "reload" }));

    await waitFor(() => expect(rowsOf()).toHaveLength(2));
    expect(state.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("staleBody")).toBeNull();

    // And the next save carries the key of that read.
    state.put.mockResolvedValue({ placements: [], verdicts: [], rowsKey: "k", lengths: [] });
    await user.click(saveButton());
    await waitFor(() => expect(state.put).toHaveBeenCalledTimes(2));
    expect(state.put.mock.calls[1]![1].baseKey).toBe("new-key");
  });

  it("says the base timetable is being written, when it is", async () => {
    answer([stored(1)]);
    state.put.mockRejectedValue(new ApiError(409, "x", "SCHEDULE_BUSY"));
    const { user } = await opened();

    await user.click(saveButton());

    expect(await screen.findByText("busy")).toBeInTheDocument();
  });

  it("says what the gateway said of any other failure", async () => {
    answer([stored(1)]);
    state.put.mockRejectedValue(new ApiError(400, "placements: en sal finns inte i skolan."));
    const { user } = await opened();

    await user.click(saveButton());

    expect(await screen.findByText("placements: en sal finns inte i skolan.")).toBeInTheDocument();
  });

  it("clears the top error at the next save", async () => {
    answer([stored(1)]);
    state.put.mockRejectedValueOnce(new ApiError(409, "x", "SCHEDULE_BUSY"));
    const { user, onOpenChange } = await opened();
    await user.click(saveButton());
    await screen.findByText("busy");

    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByText("busy")).toBeNull();
  });
});

describe("a block that cannot be placed", () => {
  it("that follows another block says so by that block's name, asks nothing to be added and offers no save", async () => {
    renderDialog({ block: { ...BLOCK, sameTimesAsBlockId: "b-other" }, followedName: "Elevens val åk 7" });

    expect(await screen.findByText("fit.FOLLOWER(Elevens val åk 7)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
    await waitFor(() => expect(saveButton()).toBeDisabled());
    expect(rowsOf()).toHaveLength(0);
  });

  it("that follows a block the page has no name for says so in general words", async () => {
    renderDialog({ block: { ...BLOCK, sameTimesAsBlockId: "b-other" } });

    expect(await screen.findByText("fit.FOLLOWER(otherBlock)")).toBeInTheDocument();
  });

  it("with a post that shares its lessons between teachers says so", async () => {
    renderDialog({
      members: [post("r-ty", { shares: [{ teacherId: "t-2", lessons: 1, minutes: 40 }] } as Partial<TeachingRequirement>), post("r-fr")],
    });

    expect(await screen.findByText(/^fit\.SHARES/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
  });

  it("with no post says so", async () => {
    answer([], [], []);
    renderDialog({ members: [] });

    expect(await screen.findByText(/^fit\.EMPTY/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
  });

  it("still lists what was stored before it became so, shut, to be removed: the one save it takes, which sends none", async () => {
    answer([stored(1), stored(2, { dayOfWeek: 4 })]);
    const { user, onOpenChange } = renderDialog({ block: { ...BLOCK, sameTimesAsBlockId: "b-other" }, followedName: "Elevens val åk 7" });
    await screen.findByRole("group", { name: /rowTitle\(2\)/ });

    expect(field(rowNamed(1), "day")).toBeDisabled();
    expect(field(rowNamed(1), "start")).toBeDisabled();
    expect(roomOf(rowNamed(1), "r-ty")).toBeDisabled();
    // The lessons cannot be saved as they are, so the save waits until they are all removed.
    expect(saveButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "remove(2)" }));
    expect(saveButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "remove(1)" }));
    expect(saveButton()).toBeEnabled();
    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(state.put).toHaveBeenCalledWith("/api/v1/teaching-blocks/b-sv/placements", { placements: [], baseKey: "key-1" });
  });
});

describe("for a screen reader and the keyboard", () => {
  it("gives every field of every lesson a label of its own, names each lesson, and keeps the ids apart", async () => {
    answer([stored(1), stored(2, { dayOfWeek: 4 })]);
    await opened();

    for (const n of [1, 2]) {
      const row = rowNamed(n);
      const labels = ["day", "start", "length", ...MEMBERS.map((member) => `roomOf(${NAMES[member.id]})`)];
      for (const name of labels) {
        const control = field(row, name);
        expect(control.labels?.[0]?.textContent).toBe(name);
        // Unique across the dialog, or a label would point at the other lesson's field.
        expect(document.querySelectorAll(`[id="${control.id}"]`)).toHaveLength(1);
      }
    }
    expect(screen.getByRole("button", { name: "remove(1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "remove(2)" })).toBeInTheDocument();
  });

  it("names the group of rooms after the word for it, for each lesson", async () => {
    answer([stored(1)]);
    await opened();

    expect(within(rowNamed(1)).getByRole("group", { name: "rooms" })).toBeInTheDocument();
  });

  it("is reached in reading order: the day, the start, the length, then each post's room, then Ta bort, then Lägg till, then Spara", async () => {
    answer([stored(1)]);
    const { user } = await opened();

    field(rowNamed(1), "day").focus();
    const order: string[] = [];
    for (let step = 0; step < 9; step += 1) {
      const active = document.activeElement as HTMLInputElement;
      order.push(active.getAttribute("aria-label") ?? active.labels?.[0]?.textContent ?? active.textContent ?? "");
      await user.tab();
    }
    expect(order).toEqual([
      "day",
      "start",
      "length",
      "roomOf(Tyska för Ty7)",
      "roomOf(Franska för Fr7)",
      "roomOf(Spanska för Sp7)",
      "remove(1)",
      "add",
      "cancel",
    ]);
  });

  it("starts at the first lesson's first field once the lessons are read, or at the button that adds one when there is none", async () => {
    answer([stored(1)]);
    await opened();
    // The focus is set by an effect once the lessons are drawn, one render after the read: waited for, as a loaded machine draws it late.
    await waitFor(() => expect(field(rowNamed(1), "day")).toHaveFocus());
  });

  it("starts at the button that adds a lesson when none is placed", async () => {
    await opened();
    await waitFor(() => expect(screen.getByRole("button", { name: "add" })).toHaveFocus());
  });

  it("closes on Escape", async () => {
    const { user, onOpenChange } = await opened();

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
