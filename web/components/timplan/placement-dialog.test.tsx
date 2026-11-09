import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { LessonShare } from "@/lib/lesson-shares";
import type { TeachingRequirement } from "@/lib/types";
import { PlacementDialog } from "./placement-dialog";

/**
 * Förlägg. What the gateway judges, stores and refuses is its own specs'; here
 * the GET is answered, the PUT recorded and answered, and the dialog is held to
 * what it offers (only what the post can be saved with), what it shows of the
 * verdicts it was given, what it sends, and where it says a refusal.
 */

const state = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  readOnly: false,
  rooms: [] as { id: string; name: string }[],
  roomsFailed: false,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: state.get, put: state.put },
}));
vi.mock("@/lib/queries", () => ({
  useRooms: () => ({ data: state.roomsFailed ? undefined : state.rooms, isError: state.roomsFailed }),
}));
vi.mock("@/components/profile-context", () => ({ useReadOnly: () => state.readOnly }));
vi.mock("sonner", () => ({ toast: { success: state.success, error: state.error } }));
// Keys echoed with their values: the sentences are i18n/placements-messages.test.ts's.
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values ? `${key}(${Object.values(values).join("|")})` : key,
      { has: () => true },
    ),
}));

const post = (extra: Partial<TeachingRequirement> = {}) =>
  ({
    id: "r-sl",
    academicYearId: "y1",
    subjectId: "s-sl",
    studentGroupId: "g-7a",
    teacherId: "t1",
    coTeacherId: null,
    lessonsPerWeek: 2,
    minutesPerLesson: 60,
    lessonLengths: [],
    minutesBefore: 0,
    minutesAfter: 0,
    teacherLoadPercent: 100,
    coTeacherLoadPercent: 100,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    blockId: null,
    ...extra,
  }) as TeachingRequirement;

const stored = (extra: Record<string, unknown> = {}) => ({
  id: "p1",
  requirementId: "r-sl",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  minutes: 60,
  roomId: "room-sim",
  roomName: "Simhallen",
  recurrence: "ALL_WEEKS",
  teacherId: null,
  ...extra,
});

/** The GET: the rows and a verdict for each, all holding unless a test says. */
function answer(placements: ReturnType<typeof stored>[], verdicts?: unknown[]) {
  state.get.mockResolvedValue({
    placements,
    verdicts: verdicts ?? placements.map((_, index) => ({ index, ok: true })),
  });
}

/** The page's list of people, as it names a teacher. */
const NAMES: Record<string, string> = { t1: "Anna Ek", t2: "Bo Alm", t3: "Cilla Öst" };
const teacherName = (id: string) => NAMES[id] ?? null;

function renderDialog(requirement: TeachingRequirement = post(), shares?: readonly LessonShare[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PlacementDialog
        open
        onOpenChange={onOpenChange}
        requirement={requirement}
        name="7A · Slöjd"
        shares={shares}
        teacherName={teacherName}
      />
    </QueryClientProvider>,
  );
  return { invalidate, onOpenChange, user: userEvent.setup() };
}

/** The dialog once its rows have been read. */
async function opened(...args: Parameters<typeof renderDialog>) {
  const rendered = renderDialog(...args);
  await screen.findByRole("button", { name: "add" });
  return rendered;
}

/** The rows, each a fieldset with a legend of its own (the one around them has none). */
const rowsOf = () => screen.queryAllByRole("group").filter((group) => group.querySelector(":scope > legend") !== null);
const rowNamed = (n: number) => screen.getByRole("group", { name: new RegExp(`rowTitle\\(${n}\\)`) });
const saveButton = () => screen.getByRole("button", { name: "save" });
const field = (row: HTMLElement, label: string) => within(row).getByLabelText(label) as HTMLInputElement;
/** A field that is a select. */
const select = (row: HTMLElement, label: string) => within(row).getByLabelText(label) as HTMLSelectElement;

beforeEach(() => {
  state.get.mockReset();
  state.put.mockReset().mockResolvedValue({ placements: [], verdicts: [] });
  state.success.mockReset();
  state.error.mockReset();
  state.readOnly = false;
  state.roomsFailed = false;
  // Out of order on purpose: the dialog lists them by name.
  state.rooms = [
    { id: "room-gym", name: "Gymnastiksalen" },
    { id: "room-aula", name: "Aulan" },
    { id: "room-sim", name: "Simhallen" },
  ];
  answer([]);
});

describe("the dialog", () => {
  it("is named after the post and reads the post's own rows when it opens", async () => {
    answer([stored()]);
    await opened();

    expect(screen.getByRole("dialog", { name: "title(7A · Slöjd)" })).toBeInTheDocument();
    expect(state.get).toHaveBeenCalledWith("/api/v1/teaching-requirements/r-sl/placements");
  });

  it("draws one labelled row for each lesson that is placed", async () => {
    answer([stored(), stored({ id: "p2", dayOfWeek: 4, startTime: "13:15", endTime: "14:15", roomId: "room-gym", roomName: "Gymnastiksalen" })]);
    await opened();

    expect(rowsOf()).toHaveLength(2);
    const first = rowNamed(1);
    expect(field(first, "day").value).toBe("2");
    expect(field(first, "start").value).toBe("10:00");
    expect(field(first, "room").value).toBe("room-sim");
    expect(field(first, "weeks").value).toBe("ALL_WEEKS");
    const second = rowNamed(2);
    expect(field(second, "day").value).toBe("4");
    expect(field(second, "start").value).toBe("13:15");
    expect(field(second, "room").value).toBe("room-gym");
  });

  it("offers Monday to Friday and the school's rooms by name", async () => {
    answer([stored()]);
    await opened();

    const row = rowNamed(1);
    expect([...select(row, "day").options].map((option) => option.value)).toEqual(["1", "2", "3", "4", "5"]);
    expect([...select(row, "room").options].map((option) => option.textContent)).toEqual([
      "roomPlaceholder",
      "Aulan",
      "Gymnastiksalen",
      "Simhallen",
    ]);
  });

  it("takes the time in five-minute steps, and says when the lesson ends", async () => {
    answer([stored()]);
    await opened();

    const start = field(rowNamed(1), "start");
    expect(start).toHaveAttribute("type", "time");
    expect(start).toHaveAttribute("step", "300");
    expect(screen.getByText("ends(11:00)")).toBeInTheDocument();
  });

  it("says that a change applies at the next Generate, that a hand move holds only until then, and that a placed lesson never gives way", async () => {
    await opened();

    expect(screen.getByText("nextGenerate")).toBeInTheDocument();
    expect(screen.getByText("handMove")).toBeInTheDocument();
    expect(screen.getByText("neverGivesWay")).toBeInTheDocument();
  });

  it("keeps a room the list no longer offers, as stored", async () => {
    answer([stored({ roomId: "room-gone", roomName: "Gamla salen" })]);
    await opened();

    const room = field(rowNamed(1), "room");
    expect(room.value).toBe("room-gone");
    expect(within(room).getByRole("option", { name: "Gamla salen" })).toBeInTheDocument();
  });

  it("says the rooms could not be read, instead of offering none", async () => {
    state.roomsFailed = true;
    answer([stored()]);
    await opened();

    expect(screen.getByText("roomsFailed")).toBeInTheDocument();
  });

  it("says the rows could not be read, and offers nothing to save over them", async () => {
    state.get.mockRejectedValue(new ApiError(500, "boom"));
    renderDialog();

    expect(await screen.findByText("loadFailed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
    expect(saveButton()).toBeDisabled();
  });
});

describe("the length", () => {
  it("is the post's own when it has one, and not asked", async () => {
    answer([stored()]);
    await opened();

    expect(within(rowNamed(1)).queryByLabelText("length")).toBeNull();
  });

  it("is asked when the post has several, among the post's lengths", async () => {
    const mixed = post({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    answer([stored({ minutes: 80, endTime: "11:20" })]);
    await opened(mixed);

    const length = select(rowNamed(1), "length");
    expect(length.value).toBe("80");
    expect([...length.options].map((option) => option.value)).toEqual(["80", "40"]);
  });

  it("is sent as chosen", async () => {
    const mixed = post({ lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] });
    answer([stored({ minutes: 80, endTime: "11:20" })]);
    const { user } = await opened(mixed);

    await user.selectOptions(field(rowNamed(1), "length"), "40");
    await user.click(saveButton());

    await waitFor(() => expect(state.put).toHaveBeenCalled());
    expect(state.put.mock.calls[0]![1].placements[0]).toMatchObject({ minutes: 40 });
  });
});

describe("the weeks", () => {
  it("are any of the three on a post that runs every week, with the words about pairs", async () => {
    answer([stored()]);
    await opened();

    const weeks = select(rowNamed(1), "weeks");
    expect([...weeks.options].map((option) => option.value)).toEqual(["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"]);
    expect(weeks).not.toBeDisabled();
    const hint = screen.getByText("pairsHint");
    expect(weeks.getAttribute("aria-describedby")).toBe(hint.id);
  });

  it.each([
    ["ODD_WEEKS", "weeksLockedOdd"],
    ["EVEN_WEEKS", "weeksLockedEven"],
  ] as const)("are the post's only, set and locked, on a post of %s", async (recurrence, hint) => {
    answer([stored({ recurrence })]);
    await opened(post({ recurrence }));

    const weeks = select(rowNamed(1), "weeks");
    expect(weeks.value).toBe(recurrence);
    expect([...weeks.options].map((option) => option.value)).toEqual([recurrence]);
    expect(weeks).toBeDisabled();
    expect(screen.getByText(hint)).toBeInTheDocument();
    // Pairs are for a post that runs every week.
    expect(screen.queryByText("pairsHint")).toBeNull();
  });

  it("are set to the post's on a row added to a post of odd weeks", async () => {
    const odd = post({ recurrence: "ODD_WEEKS" });
    const { user } = await opened(odd);

    await user.click(screen.getByRole("button", { name: "add" }));

    expect(field(rowNamed(1), "weeks").value).toBe("ODD_WEEKS");
    expect(field(rowNamed(1), "weeks")).toBeDisabled();
  });
});

describe("adding and removing a lesson", () => {
  it("starts a row with nothing chosen but the post's length and weeks, and moves to its first field", async () => {
    const { user } = await opened();

    expect(screen.getByText("empty")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "add" }));

    const row = rowNamed(1);
    expect(field(row, "start").value).toBe("");
    expect(field(row, "room").value).toBe("");
    expect(field(row, "weeks").value).toBe("ALL_WEEKS");
    expect(field(row, "day")).toHaveFocus();
    expect(screen.queryByText("empty")).toBeNull();
  });

  it("stops at the post's lessons: no more rows than it has", async () => {
    answer([stored(), stored({ id: "p2" })]);
    await opened(post({ lessonsPerWeek: 2 }));

    const add = screen.getByRole("button", { name: "add" });
    expect(add).toBeDisabled();
    expect(add.getAttribute("aria-describedby")).toBe(screen.getByText("addFull(2)").id);
  });

  it("counts an odd and an even row of one length as one lesson, a pair", async () => {
    answer([stored({ recurrence: "ODD_WEEKS" }), stored({ id: "p2", dayOfWeek: 4, recurrence: "EVEN_WEEKS" })]);
    await opened(post({ lessonsPerWeek: 2 }));

    // Two rows, one lesson: the post has room for another.
    expect(screen.getByRole("button", { name: "add" })).toBeEnabled();
  });

  it("adds the other half of a pair that has only one", async () => {
    answer([stored({ recurrence: "ODD_WEEKS" })]);
    const { user } = await opened(post({ lessonsPerWeek: 1 }));

    // The post's one lesson is placed on odd weeks, and the add is still open: the even half is missing.
    const add = screen.getByRole("button", { name: "add" });
    expect(add).toBeEnabled();
    await user.click(add);

    const second = rowNamed(2);
    expect(field(second, "weeks").value).toBe("EVEN_WEEKS");
    expect(field(second, "room").value).toBe("room-sim");
    expect(field(second, "day").value).toBe("2");
    expect(field(second, "start").value).toBe("");
    // Both halves are there: the post has no lesson left to place.
    expect(screen.getByRole("button", { name: "add" })).toBeDisabled();
  });

  it("removes a row, and the rows after it move up", async () => {
    answer([stored(), stored({ id: "p2", dayOfWeek: 4 })]);
    const { user } = await opened();

    await user.click(screen.getByRole("button", { name: "remove(1)" }));

    expect(rowsOf()).toHaveLength(1);
    expect(field(rowNamed(1), "day").value).toBe("4");
    // Focus goes to the add button, not to the body the removed row leaves behind.
    expect(screen.getByRole("button", { name: "add" })).toHaveFocus();
  });

  it("says that saving an emptied list removes the placements, and sends it empty", async () => {
    answer([stored()]);
    const { user, onOpenChange, invalidate } = await opened();

    expect(screen.queryByText("emptySave")).toBeNull();
    await user.click(screen.getByRole("button", { name: "remove(1)" }));
    expect(screen.getByText("emptySave")).toBeInTheDocument();
    await user.click(saveButton());

    await waitFor(() => expect(state.put).toHaveBeenCalledWith("/api/v1/teaching-requirements/r-sl/placements", { placements: [] }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["requirementPlacements"] });
  });
});

describe("the verdicts it was given", () => {
  const clash = { otherKind: "LESSON", className: "7B", subjectName: "Matematik", day: 2, start: "10:00", end: "11:00" };

  it("puts the reason a row no longer holds in red on that row, and says how many do not", async () => {
    answer(
      [stored(), stored({ id: "p2", dayOfWeek: 4 })],
      [
        { index: 0, ok: false, reason: "TEACHER", params: clash },
        { index: 1, ok: true },
      ],
    );
    await opened();

    const first = rowNamed(1);
    const reason = within(first).getByText(/^verdict\.TEACHER/);
    expect(reason).toHaveClass("text-destructive");
    // Tied to the row and to its first field, so it is read with them.
    expect(first.getAttribute("aria-describedby")).toBe(reason.id);
    expect(field(first, "day").getAttribute("aria-describedby")).toBe(reason.id);
    expect(field(first, "day")).toBeInvalid();
    expect(within(rowNamed(2)).queryByText(/^verdict\./)).toBeNull();
    expect(screen.getByText("staleTitle(1)")).toBeInTheDocument();
  });

  it("lets go of a verdict once its row is changed: it was said of the row as it was", async () => {
    answer([stored()], [{ index: 0, ok: false, reason: "ROOM", params: { ...clash, otherKind: "PLACEMENT" } }]);
    const { user } = await opened();
    expect(screen.getByText(/^verdict\.ROOM/)).toBeInTheDocument();

    await user.selectOptions(field(rowNamed(1), "room"), "room-aula");

    expect(screen.queryByText(/^verdict\.ROOM/)).toBeNull();
    expect(screen.queryByText("staleTitle(1)")).toBeNull();
  });

  it("says the general sentence for a row that fails without a reason", async () => {
    answer([stored()], [{ index: 0, ok: false }]);
    await opened();

    expect(screen.getByText(/^verdict\.UNKNOWN/)).toBeInTheDocument();
  });
});

describe("saving", () => {
  it("sends the whole list as the gateway takes it, then closes with a word and reads the marks again", async () => {
    answer([stored()]);
    const { user, onOpenChange, invalidate } = await opened();

    await user.selectOptions(field(rowNamed(1), "day"), "3");
    fireEvent.change(field(rowNamed(1), "start"), { target: { value: "09:05" } });
    await user.selectOptions(field(rowNamed(1), "room"), "room-aula");
    await user.selectOptions(field(rowNamed(1), "weeks"), "EVEN_WEEKS");
    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(state.put).toHaveBeenCalledWith("/api/v1/teaching-requirements/r-sl/placements", {
      placements: [{ dayOfWeek: 3, startTime: "09:05", minutes: 60, roomId: "room-aula", recurrence: "EVEN_WEEKS" }],
    });
    expect(state.success).toHaveBeenCalledWith("saved");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["requirementPlacements"] });
  });

  it("asks for a room and a start that fits the school day before it sends, and moves to the first one", async () => {
    const { user } = await opened();
    await user.click(screen.getByRole("button", { name: "add" }));
    await user.click(screen.getByRole("button", { name: "add" }));

    await user.click(saveButton());

    const first = rowNamed(1);
    const start = field(first, "start");
    expect(state.put).not.toHaveBeenCalled();
    expect(start).toBeInvalid();
    expect(start.getAttribute("aria-describedby")).toContain(within(first).getByText(/^problemStart/).id);
    expect(field(first, "room")).toBeInvalid();
    expect(within(first).getByText("problemRoom")).toBeInTheDocument();
    expect(start).toHaveFocus();
    expect(within(rowNamed(2)).getByText("problemRoom")).toBeInTheDocument();
  });

  it.each([
    ["too early", "07:55"],
    ["off the grid", "10:02"],
    ["ending after the school day", "17:30"],
  ])("will not send a start %s", async (_what, time) => {
    answer([stored()]);
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
    expect(within(rowNamed(1)).getByText("problemRoom")).toBeInTheDocument();

    await user.selectOptions(field(rowNamed(1), "room"), "room-aula");

    expect(within(rowNamed(1)).queryByText("problemRoom")).toBeNull();
  });
});

describe("a refused save", () => {
  const refusedRow = (index: number) =>
    new ApiError(409, "x", "REQUIREMENT_PLACEMENT_REFUSED", {
      index,
      reason: "TEACHER",
      otherKind: "LESSON",
      className: "7B",
      subjectName: "Matematik",
      day: 2,
      start: "10:00",
      end: "11:00",
    });

  it("says the reason at the row the gateway names, moves to it, and writes nothing else", async () => {
    answer([stored(), stored({ id: "p2", dayOfWeek: 4 })]);
    state.put.mockRejectedValue(refusedRow(1));
    const { user, onOpenChange } = await opened();

    await user.click(saveButton());

    const second = rowNamed(2);
    const reason = await within(second).findByText(/^verdict\.TEACHER/);
    expect(reason).toHaveClass("text-destructive");
    expect(field(second, "day").getAttribute("aria-describedby")).toBe(reason.id);
    expect(field(second, "day")).toBeInvalid();
    expect(field(second, "day")).toHaveFocus();
    expect(within(rowNamed(1)).queryByText(/^verdict\./)).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });

  it("keeps the reason on its row when a row before it is removed, and drops it when the row is changed", async () => {
    answer([stored(), stored({ id: "p2", dayOfWeek: 4 })]);
    state.put.mockRejectedValue(refusedRow(1));
    const { user } = await opened();
    await user.click(saveButton());
    await screen.findByText(/^verdict\.TEACHER/);

    await user.click(screen.getByRole("button", { name: "remove(1)" }));
    // The row it was said of is now the first, and still carries it.
    expect(within(rowNamed(1)).getByText(/^verdict\.TEACHER/)).toBeInTheDocument();

    await user.selectOptions(field(rowNamed(1), "day"), "5");
    expect(screen.queryByText(/^verdict\.TEACHER/)).toBeNull();
  });

  it("says at the top, and moves there, that the rows do not fit the post", async () => {
    answer([stored()]);
    state.put.mockRejectedValue(new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "PAIRS" }));
    const { user } = await opened();

    await user.click(saveButton());

    const top = (await screen.findByText("problem.PAIRS")).closest("[tabindex='-1']") as HTMLElement;
    expect(top).toHaveFocus();
    expect(within(top).getByText("notSaved")).toBeInTheDocument();
  });

  it("says the base timetable is being written, when it is", async () => {
    answer([stored()]);
    state.put.mockRejectedValue(new ApiError(409, "x", "SCHEDULE_BUSY"));
    const { user } = await opened();

    await user.click(saveButton());

    expect(await screen.findByText("busy")).toBeInTheDocument();
  });

  it("says what the gateway said of any other failure", async () => {
    answer([stored()]);
    state.put.mockRejectedValue(new ApiError(500, "Servern svarade inte."));
    const { user } = await opened();

    await user.click(saveButton());

    expect(await screen.findByText("Servern svarade inte.")).toBeInTheDocument();
  });

  it("clears the top error at the next save", async () => {
    answer([stored()]);
    state.put.mockRejectedValueOnce(new ApiError(409, "x", "SCHEDULE_BUSY"));
    const { user, onOpenChange } = await opened();
    await user.click(saveButton());
    await screen.findByText("busy");

    await user.click(saveButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByText("busy")).toBeNull();
  });
});

describe("a post that cannot be placed", () => {
  it("in a parallel block says so, asks nothing of the gateway and offers no save", async () => {
    renderDialog(post({ blockId: "b1" }));

    expect(await screen.findByText("problem.BLOCK")).toBeInTheDocument();
    expect(state.get).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
  });

  it("that shares its lessons between teachers can be placed: it reads its rows and offers a save", async () => {
    await opened(post(), [{ teacherId: "t2", lessons: 1, minutes: 60 }]);

    expect(state.get).toHaveBeenCalledWith("/api/v1/teaching-requirements/r-sl/placements");
    expect(screen.queryByText("problem.SHARES")).toBeNull();
    expect(saveButton()).toBeEnabled();
  });
});

describe("a post that shares nothing", () => {
  it("has no teacher field and no count per teacher, and sends its rows without a teacher", async () => {
    answer([stored()]);
    const { user } = await opened();

    expect(within(rowNamed(1)).queryByLabelText("teacher")).toBeNull();
    expect(screen.queryByText(/^perTeacher/)).toBeNull();
    await user.click(saveButton());

    await waitFor(() => expect(state.put).toHaveBeenCalled());
    expect(state.put.mock.calls[0]![1].placements[0]).not.toHaveProperty("teacherId");
  });

  it("is the same when its shares are an empty list", async () => {
    answer([stored()]);
    await opened(post(), []);

    expect(within(rowNamed(1)).queryByLabelText("teacher")).toBeNull();
  });
});

describe("a post that shares its lessons between teachers", () => {
  /** Anna (the post's teacher) has two of its three lessons, Bo one. */
  const three = post({ lessonsPerWeek: 3 });
  const boOne: LessonShare[] = [{ teacherId: "t2", lessons: 1, minutes: 60 }];
  const optionsOf = (select: HTMLSelectElement) => [...select.options].map((option) => option.textContent);

  it("asks whose lesson each row is, among the teachers that have a part, by name", async () => {
    answer([stored({ teacherId: "t1" }), stored({ id: "p2", dayOfWeek: 4, teacherId: "t2" })]);
    await opened(three, boOne);

    const first = select(rowNamed(1), "teacher");
    expect(first.value).toBe("t1");
    expect(optionsOf(first)).toEqual(["teacherPlaceholder", "Anna Ek", "Bo Alm"]);
    expect(select(rowNamed(2), "teacher").value).toBe("t2");
    expect(first.labels?.[0]?.textContent).toBe("teacher");
  });

  it("counts each teacher's placed lessons against their part, in a line", async () => {
    answer([stored({ teacherId: "t1" }), stored({ id: "p2", dayOfWeek: 4, teacherId: "t2" })]);
    await opened(three, boOne);

    expect(screen.getByText(/^perTeacher/)).toHaveTextContent(
      "perTeacher(teacherCount(Anna Ek|1|2), teacherCount(Bo Alm|1|1))",
    );
  });

  it("keeps the count as the rows change: another teacher for a row moves a lesson between them", async () => {
    answer([stored({ teacherId: "t1" })]);
    const { user } = await opened(three, boOne);

    await user.selectOptions(select(rowNamed(1), "teacher"), "t2");

    expect(screen.getByText(/^perTeacher/)).toHaveTextContent(
      "perTeacher(teacherCount(Anna Ek|0|2), teacherCount(Bo Alm|1|1))",
    );
  });

  it("sends whose lesson each row is", async () => {
    answer([stored({ teacherId: "t1" }), stored({ id: "p2", dayOfWeek: 4, teacherId: "t1" })]);
    const { user } = await opened(three, boOne);

    await user.selectOptions(select(rowNamed(2), "teacher"), "t2");
    await user.click(saveButton());

    await waitFor(() => expect(state.put).toHaveBeenCalled());
    const sent = state.put.mock.calls[0]![1].placements;
    expect(sent.map((row: { teacherId: string }) => row.teacherId)).toEqual(["t1", "t2"]);
  });

  describe("adding a lesson", () => {
    it("gives the new row to the first teacher with a lesson left", async () => {
      answer([stored({ teacherId: "t1" }), stored({ id: "p2", teacherId: "t1" })]);
      const { user } = await opened(three, boOne);

      // Anna's two are placed; Bo's one is not.
      await user.click(screen.getByRole("button", { name: "add" }));

      expect(select(rowNamed(3), "teacher").value).toBe("t2");
      expect(field(rowNamed(3), "day")).toHaveFocus();
    });

    it("starts with the huvudlärare when nothing is placed", async () => {
      const { user } = await opened(three, boOne);

      await user.click(screen.getByRole("button", { name: "add" }));

      expect(select(rowNamed(1), "teacher").value).toBe("t1");
    });

    it("stops when every lesson that has a teacher is placed, and says so", async () => {
      answer([
        stored({ teacherId: "t1" }),
        stored({ id: "p2", teacherId: "t1" }),
        stored({ id: "p3", teacherId: "t2" }),
      ]);
      await opened(three, boOne);

      const add = screen.getByRole("button", { name: "add" });
      expect(add).toBeDisabled();
      expect(add.getAttribute("aria-describedby")).toBe(screen.getByText("addFullShared").id);
    });

    it("counts a pair of odd and even weeks as one lesson of one teacher, and adds the other half of a lone one", async () => {
      // Anna and Bo have one lesson each. Anna's is placed on odd weeks, Bo's on even: two halves
      // of two different lessons, and neither is a pair.
      const two = post({ lessonsPerWeek: 2 });
      answer([
        stored({ teacherId: "t1", recurrence: "ODD_WEEKS" }),
        stored({ id: "p2", dayOfWeek: 4, teacherId: "t2", recurrence: "EVEN_WEEKS" }),
      ]);
      const { user } = await opened(two, boOne);

      expect(screen.getByText(/^perTeacher/)).toHaveTextContent(
        "perTeacher(teacherCount(Anna Ek|1|1), teacherCount(Bo Alm|1|1))",
      );
      const add = screen.getByRole("button", { name: "add" });
      expect(add).toBeEnabled();
      await user.click(add);

      // The missing half is the first lone row's, Anna's, on the weeks she lacks.
      expect(select(rowNamed(3), "teacher").value).toBe("t1");
      expect(field(rowNamed(3), "weeks").value).toBe("EVEN_WEEKS");
      expect(screen.getByText("pairsHintShared")).toBeInTheDocument();
      expect(screen.queryByText("pairsHint")).toBeNull();
    });
  });

  describe("on a post of two lengths", () => {
    // Anna has 1 × 80 and 1 × 40, Bo 1 × 40.
    const mixed = post({ lessonsPerWeek: 3, minutesPerLesson: 80, lessonLengths: [80, 40, 40] });
    const boFortyShare: LessonShare[] = [{ teacherId: "t2", lessons: 1, minutes: 40 }];
    const lengths = (row: HTMLElement) => [...select(row, "length").options].map((option) => option.value);

    it("offers the chosen teacher's lengths only", async () => {
      answer([
        stored({ teacherId: "t1", minutes: 80, endTime: "11:20" }),
        stored({ id: "p2", teacherId: "t2", minutes: 40, endTime: "10:40" }),
      ]);
      await opened(mixed, boFortyShare);

      expect(lengths(rowNamed(1))).toEqual(["80", "40"]);
      expect(lengths(rowNamed(2))).toEqual(["40"]);
    });

    it("keeps the row's length for a teacher who has it, and takes the teacher's first when they do not", async () => {
      answer([
        stored({ teacherId: "t1", minutes: 40, endTime: "10:40" }),
        stored({ id: "p2", teacherId: "t1", minutes: 80, endTime: "11:20" }),
      ]);
      const { user } = await opened(mixed, boFortyShare);

      await user.selectOptions(select(rowNamed(1), "teacher"), "t2");
      await user.selectOptions(select(rowNamed(2), "teacher"), "t2");

      expect(select(rowNamed(1), "length").value).toBe("40");
      expect(select(rowNamed(2), "length").value).toBe("40");
    });

    it("counts a teacher's lessons of each length: another of one length is not open when its own are placed", async () => {
      // Bo's one lesson of 40 is placed; Anna has 80 and 40 to place.
      answer([stored({ teacherId: "t2", minutes: 40, endTime: "10:40" })]);
      const { user } = await opened(mixed, boFortyShare);

      await user.click(screen.getByRole("button", { name: "add" }));

      expect(select(rowNamed(2), "teacher").value).toBe("t1");
      expect(select(rowNamed(2), "length").value).toBe("80");
    });
  });

  describe("a part nobody teaches", () => {
    // The post has no huvudlärare: one of its two lessons has no teacher; Bo has the other.
    const unstaffed = post({ teacherId: null, lessonsPerWeek: 2 });

    it("is said to need a teacher first, and is not offered", async () => {
      await opened(unstaffed, boOne);

      expect(screen.getByText("noTeacher(1)")).toBeInTheDocument();
      expect(screen.getByText(/^perTeacher/)).toHaveTextContent("perTeacher(teacherCount(Bo Alm|0|1))");
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "add" }));
      expect(optionsOf(select(rowNamed(1), "teacher"))).toEqual(["teacherPlaceholder", "Bo Alm"]);
      expect(select(rowNamed(1), "teacher").value).toBe("t2");
    });

    it("leaves the add button closed once the lessons that have a teacher are placed", async () => {
      answer([stored({ teacherId: "t2" })]);
      await opened(unstaffed, boOne);

      expect(screen.getByRole("button", { name: "add" })).toBeDisabled();
      expect(screen.getByText("noTeacher(1)")).toBeInTheDocument();
    });

    it("says nothing of a missing teacher when every part has one", async () => {
      await opened(three, boOne);

      expect(screen.queryByText(/^noTeacher/)).toBeNull();
    });

    it("counts a share whose teacher was deleted with the lessons nobody teaches", async () => {
      await opened(three, [{ teacherId: null, lessons: 2, minutes: 60 }]);

      expect(screen.getByText("noTeacher(2)")).toBeInTheDocument();
      expect(screen.getByText(/^perTeacher/)).toHaveTextContent("perTeacher(teacherCount(Anna Ek|0|1))");
    });
  });

  describe("a stored row whose teacher was deleted", () => {
    it("shows the field empty with the reason, and will not save until a teacher is chosen", async () => {
      answer([stored({ teacherId: null })]);
      const { user } = await opened(three, boOne);

      const row = rowNamed(1);
      const teacher = select(row, "teacher");
      expect(teacher.value).toBe("");
      expect(within(row).getByText("problem.NO_TEACHER")).toBeInTheDocument();
      expect(teacher).toBeInvalid();

      await user.click(saveButton());

      expect(state.put).not.toHaveBeenCalled();
      expect(within(row).getByText("problemTeacher")).toBeInTheDocument();
      expect(teacher).toHaveFocus();

      await user.selectOptions(teacher, "t1");
      expect(within(row).queryByText("problemTeacher")).toBeNull();
      expect(within(row).queryByText("problem.NO_TEACHER")).toBeNull();
      await user.click(saveButton());
      await waitFor(() => expect(state.put).toHaveBeenCalled());
    });
  });

  it("keeps a teacher the post no longer gives a lesson, as stored, for the gateway to say what is wrong", async () => {
    answer([stored({ teacherId: "t3" })]);
    await opened(three, boOne);

    const teacher = select(rowNamed(1), "teacher");
    expect(teacher.value).toBe("t3");
    expect(optionsOf(teacher)).toContain("Cilla Öst");
  });

  it("names a teacher the page does not know without a name", async () => {
    answer([stored({ teacherId: "t-gone" })]);
    await opened(three, boOne);

    expect(optionsOf(select(rowNamed(1), "teacher"))).toContain("teacherUnnamed");
  });

  describe("a refused save", () => {
    it("says a per-teacher rule at the row the gateway names, and moves to its teacher field", async () => {
      answer([stored({ teacherId: "t1" }), stored({ id: "p2", dayOfWeek: 4, teacherId: "t2" })]);
      state.put.mockRejectedValue(
        new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "TEACHER_COUNT", index: 1 }),
      );
      const { user } = await opened(three, boOne);

      await user.click(saveButton());

      const second = rowNamed(2);
      const reason = await within(second).findByText("problem.TEACHER_COUNT");
      expect(reason).toHaveClass("text-destructive");
      expect(second.getAttribute("aria-describedby")).toBe(reason.id);
      expect(select(second, "teacher").getAttribute("aria-describedby")).toContain(reason.id);
      expect(select(second, "teacher")).toHaveFocus();
      expect(within(rowNamed(1)).queryByText(/^problem\./)).toBeNull();
    });

    it("moves to the day, not the teacher, for a rule that is not about the teacher", async () => {
      answer([stored({ teacherId: "t1" })]);
      state.put.mockRejectedValue(new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "WEEKS", index: 0 }));
      const { user } = await opened(three, boOne);

      await user.click(saveButton());

      await within(rowNamed(1)).findByText("problem.WEEKS");
      expect(field(rowNamed(1), "day")).toHaveFocus();
    });

    it("says it at the top, and moves there, when the rule names no row", async () => {
      answer([stored({ teacherId: "t1" })]);
      state.put.mockRejectedValue(new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "TEACHER_PAIRS" }));
      const { user } = await opened(three, boOne);

      await user.click(saveButton());

      const top = (await screen.findByText("problem.TEACHER_PAIRS")).closest("[tabindex='-1']") as HTMLElement;
      expect(top).toHaveFocus();
      expect(within(top).getByText("notSaved")).toBeInTheDocument();
    });

    it("says it at the top for a row index the list does not have", async () => {
      answer([stored({ teacherId: "t1" })]);
      state.put.mockRejectedValue(new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_DO_NOT_FIT", { reason: "TEACHER", index: 7 }));
      const { user } = await opened(three, boOne);

      await user.click(saveButton());

      expect(await screen.findByText("problem.TEACHER")).toBeInTheDocument();
      expect(within(rowNamed(1)).queryByText("problem.TEACHER")).toBeNull();
    });
  });

  it("is for a reader a list with every field disabled", async () => {
    state.readOnly = true;
    answer([stored({ teacherId: "t1" })]);
    renderDialog(three, boOne);
    await screen.findByLabelText("teacher");

    expect(select(rowNamed(1), "teacher")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
  });

  it("gives the teacher field a label of its own on every row", async () => {
    answer([stored({ teacherId: "t1" }), stored({ id: "p2", dayOfWeek: 4, teacherId: "t2" })]);
    await opened(three, boOne);

    for (const n of [1, 2]) {
      const control = field(rowNamed(n), "teacher");
      expect(control.labels?.[0]?.textContent).toBe("teacher");
      expect(document.querySelectorAll(`[id="${control.id}"]`)).toHaveLength(1);
    }
  });
});

describe("for a reader", () => {
  beforeEach(() => {
    state.readOnly = true;
  });

  it("shows the rows with every field disabled, and no way to add, remove or save", async () => {
    answer([stored()]);
    renderDialog();
    await screen.findByLabelText("day");

    const row = rowNamed(1);
    for (const label of ["day", "start", "room", "weeks"]) expect(field(row, label)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "add" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "save" })).toBeNull();
    // Closing is all it can do: the footer's button, beside the dialog's own X.
    expect(screen.getAllByRole("button", { name: "close" })).toHaveLength(2);
  });
});

describe("for a screen reader", () => {
  it("gives every field of every row a label of its own, and names each row", async () => {
    answer([stored(), stored({ id: "p2", dayOfWeek: 4 })]);
    await opened(post({ lessonsPerWeek: 3, minutesPerLesson: 80, lessonLengths: [80, 40, 40] }));

    for (const n of [1, 2]) {
      const row = rowNamed(n);
      for (const label of ["day", "start", "length", "room", "weeks"]) {
        const control = field(row, label);
        expect(control.labels?.[0]?.textContent).toBe(label);
        // Unique across the dialog, or a label would point at the other row's field.
        expect(document.querySelectorAll(`[id="${control.id}"]`)).toHaveLength(1);
      }
    }
    expect(screen.getByRole("button", { name: "remove(1)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "remove(2)" })).toBeInTheDocument();
  });
});
