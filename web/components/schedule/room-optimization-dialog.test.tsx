import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import type { RoomProposal } from "@/lib/queries";
import type { Room } from "@/lib/types";
import { RoomOptimizationDialog } from "./room-optimization-dialog";

/**
 * What this file guards: that the proposal is READ before it is written, and
 * that every way out of a write leaves the school somewhere it can see.
 *
 * The rules of the optimisation live in the engine and the gateway. What only
 * this dialog can get wrong is the round trip: the choice reaching the
 * request, the moves reaching the apply unchanged, the undo sending exactly
 * those moves back against the NEW basis, and a stale proposal sending the
 * admin back to compute rather than leaving an unappliable one on screen.
 */

const optimisation = vi.hoisted(() => ({
  propose: { mutateAsync: vi.fn(), isPending: false },
  apply: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock("@/lib/queries", () => ({
  useRoomOptimization: () => optimisation,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const room = (id: string, floor: number | null, building: string | null = null): Room => ({
  id,
  name: id,
  code: null,
  capacity: 30,
  roomTypeId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  requiresApproval: false,
  building,
  floor,
});

/** Sal 1 on the ground floor, sal 10 upstairs — the school's own example. */
const ROOMS = [room("r-1", 0), room("r-10", 2)];

const TEACHERS = [
  { id: "t-elin", firstName: "Elin", lastName: "Ek" },
  { id: "t-alexander", firstName: "Alexander", lastName: "Berg" },
];
const GROUPS = [{ id: "g-41", name: "4.1" }];

const MOVES = [
  { lessonId: "l-elin-2", fromRoomId: "r-10", toRoomId: "r-1" },
  { lessonId: "l-alexander-2", fromRoomId: "r-1", toRoomId: "r-10" },
];

const walk = (roomChanges: number, floorChanges: number, buildingChanges: number) => ({
  roomChanges,
  floorChanges,
  buildingChanges,
});

const proposal = (overrides: Partial<RoomProposal> = {}): RoomProposal => ({
  status: "OPTIMAL",
  basis: "basis-1",
  changes: MOVES,
  teachers: { before: walk(2, 2, 0), after: walk(0, 0, 0) },
  groups: { before: walk(5, 1, 1), after: walk(4, 1, 1) },
  missedWishes: { before: 1, after: 0 },
  walkers: [
    { kind: "TEACHER", id: "t-elin", before: walk(1, 1, 0), after: walk(0, 0, 0) },
    { kind: "TEACHER", id: "t-alexander", before: walk(1, 1, 0), after: walk(0, 0, 0) },
    // Better by the engine's weights, worse by one count: not a "biggest
    // difference" anyone would recognise, so it must not be named there.
    { kind: "GROUP", id: "g-41", before: walk(1, 0, 1), after: walk(3, 0, 0) },
  ],
  frozenLessonIds: [],
  roomsTotal: 2,
  roomsWithoutFloor: 0,
  ...overrides,
});

const onApplied = vi.fn();
const onOpenChange = vi.fn();

function dialog(open = true, rooms: Room[] = ROOMS) {
  return (
    <RoomOptimizationDialog
      open={open}
      onOpenChange={onOpenChange}
      academicYearId="y-1"
      rooms={rooms}
      teachers={TEACHERS}
      groups={GROUPS}
      onApplied={onApplied}
    />
  );
}

function renderDialog(rooms: Room[] = ROOMS) {
  return render(dialog(true, rooms));
}

async function computeProposal(result: RoomProposal = proposal()) {
  optimisation.propose.mutateAsync.mockResolvedValueOnce(result);
  const user = userEvent.setup();
  renderDialog();
  await user.click(screen.getByRole("button", { name: "compute" }));
  return user;
}

interface AppliedToast {
  description?: string;
  duration?: number;
  action: { label: string; onClick: () => void };
}

/** The options the applied toast was raised with. */
function appliedToast() {
  return vi.mocked(toast.success).mock.calls[0]?.[1] as AppliedToast;
}

/** The toast's Ångra, as sonner would call it. */
function undoFromToast() {
  const options = appliedToast();
  expect(options.action.label).toBe("undo");
  return act(async () => options.action.onClick());
}

const APPLIED = { updated: 2, basis: "basis-2", versionId: "v-1", calendarUpdated: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  optimisation.propose.isPending = false;
  optimisation.apply.isPending = false;
});

describe("choosing who is spared the walk", () => {
  it("computes for the teachers unless told otherwise", async () => {
    await computeProposal();

    expect(optimisation.propose.mutateAsync).toHaveBeenCalledWith({
      academicYearId: "y-1",
      walkers: "TEACHERS",
    });
  });

  it("sends the choice the admin made", async () => {
    optimisation.propose.mutateAsync.mockResolvedValueOnce(proposal());
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("radio", { name: "walkersGroups" }));
    await user.click(screen.getByRole("button", { name: "compute" }));

    expect(optimisation.propose.mutateAsync).toHaveBeenCalledWith({
      academicYearId: "y-1",
      walkers: "GROUPS",
    });
  });

  it("says what never changes before anything is computed", () => {
    renderDialog();
    expect(screen.getByText("unchanged")).toBeInTheDocument();
  });

  it("says it is working, and cannot be pressed twice, while the solver runs", () => {
    optimisation.propose.isPending = true;
    renderDialog();

    const button = screen.getByRole("button", { name: /computing/ });
    expect(button).toBeDisabled();
    expect(screen.getByRole("radio", { name: "walkersBoth" })).toBeDisabled();
  });
});

describe("rooms that do not say which floor they are on", () => {
  it("are counted, with the way to Salar, before a proposal exists", () => {
    renderDialog([...ROOMS, room("r-gym", null)]);

    expect(screen.getByText("floorsMissing(1|3)")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "floorsMissingLink" })).toHaveAttribute(
      "href",
      "/admin/rooms",
    );
  });

  it("are not mentioned when every room has a floor", () => {
    renderDialog();
    expect(screen.queryByText(/floorsMissing/)).not.toBeInTheDocument();
  });

  it("are counted again from what the proposal read", async () => {
    await computeProposal(proposal({ roomsTotal: 12, roomsWithoutFloor: 5 }));
    expect(screen.getByText("floorsMissing(5|12)")).toBeInTheDocument();
  });
});

describe("the proposal", () => {
  it("counts the walking before and after, for teachers and classes both", async () => {
    await computeProposal();

    const teachers = screen.getByRole("row", { name: /rowTeachers/ });
    // Rooms, floors, buildings — in the columns' order.
    expect(
      within(teachers)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["2 → 0", "2 → 0", "0 → 0"]);
    const groups = screen.getByRole("row", { name: /rowGroups/ });
    expect(
      within(groups)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["5 → 4", "1 → 1", "1 → 1"]);
    expect(screen.getByRole("row", { name: /missedWishes/ }).textContent).toContain("1 → 0");
    expect(screen.getByText("moves(2)")).toBeInTheDocument();
  });

  it("names the people it helped most from the page's own lists", async () => {
    await computeProposal();

    const list = screen.getByRole("list", { name: "mostImproved" });
    const names = within(list)
      .getAllByRole("listitem")
      .map((item) => item.firstChild?.textContent);
    expect(names).toEqual(["Elin Ek", "Alexander Berg"]);
  });

  it("does not name a walker it made worse on any count", async () => {
    await computeProposal();
    expect(
      within(screen.getByRole("list", { name: "mostImproved" })).queryByText("4.1"),
    ).not.toBeInTheDocument();
  });

  it("keeps the order the engine ranked them in by its weights", async () => {
    // Twenty rooms saved outweigh one floor (one room each, four a floor), so
    // the engine lists Elin first. A ranking of its own here — buildings, then
    // floors, then rooms — used to put 4.1 above her.
    await computeProposal(
      proposal({
        walkers: [
          { kind: "TEACHER", id: "t-elin", before: walk(20, 0, 0), after: walk(0, 0, 0) },
          { kind: "GROUP", id: "g-41", before: walk(1, 1, 0), after: walk(1, 0, 0) },
        ],
      }),
    );

    const names = within(screen.getByRole("list", { name: "mostImproved" }))
      .getAllByRole("listitem")
      .map((item) => item.firstChild?.textContent);
    expect(names).toEqual(["Elin Ek", "4.1"]);
  });

  it("names at most five, the first five it was given", async () => {
    const teachers = Array.from({ length: 7 }, (_, index) => ({
      id: `t-${index}`,
      firstName: "Lärare",
      lastName: String(index),
    }));
    optimisation.propose.mutateAsync.mockResolvedValueOnce(
      proposal({
        walkers: teachers.map((teacher) => ({
          kind: "TEACHER" as const,
          id: teacher.id,
          before: walk(1, 0, 0),
          after: walk(0, 0, 0),
        })),
      }),
    );
    const user = userEvent.setup();
    render(
      <RoomOptimizationDialog
        open
        onOpenChange={onOpenChange}
        academicYearId="y-1"
        rooms={ROOMS}
        teachers={teachers}
        groups={GROUPS}
        onApplied={onApplied}
      />,
    );
    await user.click(screen.getByRole("button", { name: "compute" }));

    const names = within(screen.getByRole("list", { name: "mostImproved" }))
      .getAllByRole("listitem")
      .map((item) => item.firstChild?.textContent);
    expect(names).toEqual(["Lärare 0", "Lärare 1", "Lärare 2", "Lärare 3", "Lärare 4"]);
  });

  it("says which lessons were left alone because they already share a room", async () => {
    await computeProposal(proposal({ frozenLessonIds: ["l-hall-1", "l-hall-2"] }));
    expect(screen.getByText("frozen(2)")).toBeInTheDocument();
  });

  it("says so, and offers nothing to apply, when there is nothing to do", async () => {
    await computeProposal(
      proposal({
        changes: [],
        walkers: [],
        teachers: { before: walk(0, 0, 0), after: walk(0, 0, 0) },
      }),
    );

    expect(screen.getByText("nothingToDo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "apply" })).not.toBeInTheDocument();
    expect(screen.queryByText("calendarNote")).not.toBeInTheDocument();
  });

  it("forgets an answer that arrives after the dialog was closed", async () => {
    // The solve outlives the close: the page keeps the dialog mounted, so the
    // late answer used to land in it and the next open offered it to apply —
    // a proposal about a schedule nobody was looking at any more.
    let answer: (value: RoomProposal) => void = () => {};
    optimisation.propose.mutateAsync.mockReturnValueOnce(
      new Promise<RoomProposal>((resolve) => {
        answer = resolve;
      }),
    );
    const user = userEvent.setup();
    const { rerender } = renderDialog();
    await user.click(screen.getByRole("button", { name: "compute" }));

    await user.click(screen.getByRole("button", { name: "cancel" }));
    rerender(dialog(false));
    await act(async () => answer(proposal()));
    rerender(dialog(true));

    expect(screen.getByRole("button", { name: "compute" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "apply" })).not.toBeInTheDocument();
  });

  it("does not report the failure of an ask that was abandoned", async () => {
    let fail: (reason: unknown) => void = () => {};
    optimisation.propose.mutateAsync.mockReturnValueOnce(
      new Promise<RoomProposal>((_, reject) => {
        fail = reject;
      }),
    );
    const user = userEvent.setup();
    const { rerender } = renderDialog();
    await user.click(screen.getByRole("button", { name: "compute" }));

    await user.click(screen.getByRole("button", { name: "cancel" }));
    rerender(dialog(false));
    await act(async () => fail(new ApiError(504, "Timeout.")));

    expect(toast.error).not.toHaveBeenCalled();
  });

  it("goes back to the choice without applying anything", async () => {
    const user = await computeProposal();
    await user.click(screen.getByRole("button", { name: "back" }));

    expect(screen.getByRole("radio", { name: "walkersTeachers" })).toBeChecked();
    expect(optimisation.apply.mutateAsync).not.toHaveBeenCalled();
  });
});

describe("applying it", () => {
  it("sends exactly the proposal's moves against the proposal's basis", async () => {
    optimisation.apply.mutateAsync.mockResolvedValueOnce(APPLIED);
    const user = await computeProposal();

    await user.click(screen.getByRole("button", { name: "apply" }));

    expect(optimisation.apply.mutateAsync).toHaveBeenCalledWith({
      academicYearId: "y-1",
      basis: "basis-1",
      changes: MOVES,
    });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("applied(2)", expect.anything());
  });

  it("keeps Ångra on screen long enough to be read and pressed", async () => {
    optimisation.apply.mutateAsync.mockResolvedValueOnce(APPLIED);
    const user = await computeProposal();

    await user.click(screen.getByRole("button", { name: "apply" }));

    // Sonner's default is 4 s — gone before the sentence above it is read.
    expect(appliedToast().duration).toBe(15_000);
  });

  it("says how many published lessons followed the change", async () => {
    optimisation.apply.mutateAsync.mockResolvedValueOnce({ ...APPLIED, calendarUpdated: 37 });
    const user = await computeProposal();

    await user.click(screen.getByRole("button", { name: "apply" }));

    expect(appliedToast().description).toBe("calendarUpdated(37)");
  });

  it("says nothing of the calendar when nothing in it moved", async () => {
    optimisation.apply.mutateAsync.mockResolvedValueOnce(APPLIED);
    const user = await computeProposal();

    await user.click(screen.getByRole("button", { name: "apply" }));

    expect(appliedToast().description).toBeUndefined();
  });

  it("undoes by sending the same moves back against the new basis", async () => {
    optimisation.apply.mutateAsync
      .mockResolvedValueOnce(APPLIED)
      .mockResolvedValueOnce({ ...APPLIED, basis: "basis-3", versionId: "v-2" });
    const user = await computeProposal();
    await user.click(screen.getByRole("button", { name: "apply" }));

    await undoFromToast();

    expect(optimisation.apply.mutateAsync).toHaveBeenLastCalledWith({
      academicYearId: "y-1",
      basis: "basis-2",
      changes: [
        { lessonId: "l-elin-2", fromRoomId: "r-1", toRoomId: "r-10" },
        { lessonId: "l-alexander-2", fromRoomId: "r-10", toRoomId: "r-1" },
      ],
    });
    // The page clears its own undo stack after the undo as well.
    expect(onApplied).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenLastCalledWith("undone");
  });

  it("points at the saved version when the undo comes too late", async () => {
    optimisation.apply.mutateAsync
      .mockResolvedValueOnce(APPLIED)
      .mockRejectedValueOnce(new ApiError(409, "stale", "ROOM_PROPOSAL_STALE"));
    const user = await computeProposal();
    await user.click(screen.getByRole("button", { name: "apply" }));

    await undoFromToast();

    expect(toast.error).toHaveBeenCalledWith("undoStale");
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("sends a stale proposal back to be computed again", async () => {
    optimisation.apply.mutateAsync.mockRejectedValueOnce(
      new ApiError(409, "The schedule changed.", "ROOM_PROPOSAL_STALE"),
    );
    const user = await computeProposal();

    await user.click(screen.getByRole("button", { name: "apply" }));

    expect(toast.error).toHaveBeenCalledWith("stale");
    expect(screen.getByRole("button", { name: "compute" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "apply" })).not.toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("shows the gateway's word for a clash, and also asks for a new proposal", async () => {
    optimisation.apply.mutateAsync.mockRejectedValueOnce(
      new ApiError(409, "Sal 10 would be double-booked on Monday 08:00."),
    );
    const user = await computeProposal();

    await user.click(screen.getByRole("button", { name: "apply" }));

    expect(toast.error).toHaveBeenCalledWith("Sal 10 would be double-booked on Monday 08:00.");
    expect(screen.getByRole("button", { name: "compute" })).toBeInTheDocument();
  });

  it("keeps the proposal on screen for any other failure", async () => {
    optimisation.apply.mutateAsync.mockRejectedValueOnce(new ApiError(500, "Boom."));
    const user = await computeProposal();

    await user.click(screen.getByRole("button", { name: "apply" }));

    expect(toast.error).toHaveBeenCalledWith("Boom.");
    expect(screen.getByRole("button", { name: "apply" })).toBeInTheDocument();
  });
});
