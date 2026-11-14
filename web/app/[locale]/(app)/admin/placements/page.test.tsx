import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlacementBoard } from "@/lib/placement-board";
import PlacementsPage from "./page";

/**
 * Förlägg i veckan, read only. What the gateway counts and judges is its own
 * specs'; here the page is held to what it makes of the answer: the figures it
 * puts first, a förläggning that no longer holds said in words and not by
 * colour alone, a post told what it has left, the lessons Generera keeps drawn
 * apart from the förläggningar, a post the link in the dialog names reached,
 * and every state of the read (loading, failed, empty) answered.
 */

const state = vi.hoisted(() => ({
  board: undefined as unknown,
  boardState: { isLoading: false, isError: false } as { isLoading: boolean; isError: boolean },
  refetch: vi.fn(),
  year: { id: "y1", name: "2026/27", startDate: "2026-08-15", endDate: "2027-06-11", isActive: true } as unknown,
  search: "",
  peopleLoading: false,
}));

vi.mock("@/lib/placement-board-queries", () => ({
  usePlacementBoard: () => ({ data: state.board, refetch: state.refetch, ...state.boardState }),
}));
vi.mock("@/lib/planning-year", () => ({
  usePlanningYear: () => ({ year: state.year, active: state.year, successor: null, choose: vi.fn(), rosters: null, rostersFailed: false }),
}));
vi.mock("@/lib/queries", () => ({
  useGroups: () => ({
    data: [
      { id: "g-7a", academicYearId: "y1", name: "7A", kind: "CLASS" },
      { id: "g-7b", academicYearId: "y1", name: "7B", kind: "CLASS" },
    ],
    isLoading: false,
  }),
  useSubjects: () => ({ data: [{ id: "s-ma", name: "Matematik", color: "#2563eb" }, { id: "s-sl", name: "Slöjd", color: null }], isLoading: false }),
  useRooms: () => ({ data: [{ id: "r-a12", name: "A12" }, { id: "r-sl", name: "Slöjdsalen" }], isLoading: false }),
  usePeople: () => ({
    data: [
      { id: "anna", role: "TEACHER", firstName: "Anna", lastName: "Ek" },
      { id: "bo", role: "TEACHER", firstName: "Bo", lastName: "Lind" },
    ],
    isLoading: state.peopleLoading,
  }),
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

const board = (over: Partial<PlacementBoard> = {}): PlacementBoard => ({
  academicYearId: "y1",
  posts: [
    {
      id: "post-ma",
      studentGroupId: "g-7a",
      subjectId: "s-ma",
      teacherId: "anna",
      recurrence: "ALL_WEEKS",
      startDate: null,
      endDate: null,
      cannotPlace: null,
      parts: [{ teacherId: "anna", minutes: 60, count: 3, locked: 1, placed: 1, left: 1, cannotPlace: null }],
    },
    {
      id: "post-sl",
      studentGroupId: "g-7b",
      subjectId: "s-sl",
      teacherId: "bo",
      recurrence: "ALL_WEEKS",
      startDate: "2026-08-24",
      endDate: "2026-12-20",
      cannotPlace: "BLOCK",
      parts: [{ teacherId: "bo", minutes: 80, count: 1, locked: 0, placed: 0, left: 1, cannotPlace: null }],
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
  ...over,
});

beforeEach(() => {
  state.board = board();
  state.boardState = { isLoading: false, isError: false };
  state.refetch.mockReset();
  state.peopleLoading = false;
  window.history.replaceState(null, "", "/sv/admin/placements");
});

const posts = () => screen.getAllByTestId("placement-post");

describe("the figures", () => {
  it("says first how many rows the year holds and how many lessons are left to lay", () => {
    render(<PlacementsPage />);
    // Two rows; one lesson left in each post (1 + 1).
    expect(screen.getByTestId("placement-summary")).toHaveTextContent("summary(2|2)");
  });

  it("names the rows that no longer hold, each with the gateway's reason, in a notice that is read out", () => {
    render(<PlacementsPage />);
    const notice = screen.getByText("failingTitle(1)").closest('[role="alert"]')!;
    const item = within(notice as HTMLElement).getByTestId("failing-row");
    expect(item).toHaveTextContent("Matematik 7A");
    // The reason is the dialog's sentence for it (verdict.TEACHER), with what the judge says is in the way.
    expect(item).toHaveTextContent("verdict.TEACHER");
  });

  it("says nothing failed when every row holds, and that nothing is placed when there is none", () => {
    state.board = board({ placements: [board().placements[0]!] });
    const { unmount } = render(<PlacementsPage />);
    expect(screen.queryByText(/failingTitle/)).not.toBeInTheDocument();
    unmount();
    state.board = board({ placements: [] });
    render(<PlacementsPage />);
    expect(screen.getByText("noneTitle")).toBeInTheDocument();
  });
});

describe("the list of posts", () => {
  it("states each post's lessons: placed of all, fixed in the grundschema, left for Generera", () => {
    render(<PlacementsPage />);
    const ma = posts().find((entry) => entry.textContent?.includes("Matematik 7A"))!;
    expect(ma).toHaveTextContent("postFigures(1|3|1|1)");
    // Its rows, each with its day (the key, echoed) and time, its room, its weeks and its verdict.
    const rows = within(ma).getAllByTestId("placement-row");
    expect(rows[0]).toHaveTextContent("2 10:00–11:00 · A12");
    expect(rows[0]).toHaveTextContent("holds");
    expect(rows[1]).toHaveTextContent("4 13:00–14:00 · A12");
    expect(rows[1]).toHaveTextContent("verdict.TEACHER");
  });

  it("says why a post in a parallel block cannot be placed, and the weeks it runs", () => {
    render(<PlacementsPage />);
    const sl = posts().find((entry) => entry.textContent?.includes("Slöjd 7B"))!;
    expect(sl).toHaveTextContent("problem.BLOCK");
  });

  it("names a post by its class and subject, in Swedish order", () => {
    render(<PlacementsPage />);
    expect(posts().map((entry) => entry.querySelector("h3")?.textContent)).toEqual(["Matematik 7A", "Slöjd 7B"]);
  });

  it("marks a part nobody teaches as one that cannot be placed", () => {
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
    render(<PlacementsPage />);
    expect(posts()[0]).toHaveTextContent("problem.NO_TEACHER");
    expect(posts()[0]).toHaveTextContent("part(noTeacher|1|60|0|0|1)");
  });
});

describe("the week", () => {
  it("draws the förläggningar and the lessons Generera keeps, the second with a padlock and a note", () => {
    render(<PlacementsPage />);
    const grid = document.querySelector("[data-lesson-id='placement:row-ma']")!;
    expect(grid).toBeInTheDocument();
    expect(document.querySelector("[data-lesson-id='placement:row-bad']")).toBeInTheDocument();
    const kept = document.querySelector("[data-lesson-id='kept:k-1']")!;
    expect(kept).toHaveTextContent("keptNote");
    expect(kept.querySelector("svg")).toBeInTheDocument();
  });

  it("draws the end of the school day when nothing else reaches it, since a förläggning's day goes to 18:00", () => {
    render(<PlacementsPage />);
    expect(document.querySelectorAll("[data-lesson-id^='day-end:']")).toHaveLength(5);
  });

  it("does not draw a week with no lesson in it, since its scrolling box would have nothing to focus", () => {
    state.board = board({ placements: [], kept: [] });
    render(<PlacementsPage />);
    expect(screen.getByTestId("placement-week-empty")).toHaveTextContent("weekEmpty");
    expect(document.querySelector("[data-lesson-id]")).not.toBeInTheDocument();
  });

  it("opens a card's own words, with its verdict, under the week", async () => {
    render(<PlacementsPage />);
    await userEvent.click(document.querySelector("[data-lesson-id='placement:row-bad']")!);
    const detail = screen.getByTestId("placement-detail");
    expect(detail).toHaveTextContent("verdict.TEACHER");
    expect(detail).toHaveTextContent("savedAt");
    expect(within(detail).getByRole("link", { name: "toPost" })).toHaveAttribute("href", "#post-post-ma");
    await userEvent.click(document.querySelector("[data-lesson-id='kept:k-1']")!);
    expect(screen.getByTestId("placement-detail")).toHaveTextContent("keptLocked");
  });

  it("draws a class's meals as bands once the class is picked", async () => {
    render(<PlacementsPage />);
    expect(screen.queryByText("meal(7A)")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /filterGroup/ }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "7A" }));
    expect(screen.getByText("meal(7A)")).toBeInTheDocument();
    // 7B's post is no longer in the list.
    expect(posts()).toHaveLength(1);
  });
});

describe("the link from the dialog", () => {
  it("opens the list on the post it names", async () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/sv/admin/placements?post=post-sl");
    render(<PlacementsPage />);
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.activeElement).toBe(document.getElementById("post-post-sl"));
  });

  it("waits for a name list that is slower than the board, then opens the list on the post (review of #315, LÅG-1)", async () => {
    const scroll = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scroll;
    window.history.replaceState(null, "", "/sv/admin/placements?post=post-sl");
    // The board is in; the people are not, so the list is a skeleton and the post's element is not there yet.
    state.peopleLoading = true;
    const { rerender } = render(<PlacementsPage />);
    expect(document.getElementById("post-post-sl")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    // The people arrive: the board has not changed, and the post is reached all the same.
    state.peopleLoading = false;
    rerender(<PlacementsPage />);
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.activeElement).toBe(document.getElementById("post-post-sl"));
  });
});

describe("the states of the read", () => {
  it("is a skeleton while it loads, and says nothing of the week", () => {
    state.board = undefined;
    state.boardState = { isLoading: true, isError: false };
    render(<PlacementsPage />);
    expect(screen.queryByTestId("placement-summary")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).toBeInTheDocument();
  });

  it("says it could not be read, with a way to try again, and no week", async () => {
    state.board = undefined;
    state.boardState = { isLoading: false, isError: true };
    render(<PlacementsPage />);
    expect(screen.getByText("loadFailed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(state.refetch).toHaveBeenCalled();
    expect(screen.queryByTestId("placement-summary")).not.toBeInTheDocument();
  });
});
