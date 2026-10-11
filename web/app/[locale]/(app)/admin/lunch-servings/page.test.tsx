import type React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LunchServingsPage from "./page";

// Radix needs these in jsdom to open a Select or a Dialog — environment, not
// behaviour under test.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * What this file guards.
 *
 * The list of rows is the easy half. The hard half is the FLOW they make:
 * sittings reaching one stage add up, and a weekday row shadows the every-day
 * one rather than widening it. Neither is visible in a list, which is why the
 * page computes it back — and a computed flow that is wrong is worse than none,
 * because it looks like an answer.
 *
 * lib/lunch-servings.ts is NOT mocked. The interesting failure is the page
 * computing the flow with a second implementation that disagrees with the one
 * the solver mirrors, and a mocked module cannot show that.
 *
 * The other half is what gets SENT: `dayOfWeek` is null for the every-day row
 * and a Select cannot hold null, and an empty seat field means the hall's own
 * limit rather than a sitting for nobody — Number("") is 0, which the API
 * refuses.
 */

interface ServingFixture {
  id: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
  seats: number | null;
}

const createMock = vi.fn();
const updateMock = vi.fn();
const removeMock = vi.fn();

const state = vi.hoisted(() => ({
  servings: { data: [], isLoading: false } as {
    data: unknown[] | undefined;
    isLoading: boolean;
    isError?: boolean;
  },
  lunch: { data: null } as { data: unknown; isError?: boolean },
  /** What the SOLVER decided, as opposed to what the school declared. */
  sittings: { data: [] } as { data: unknown[] | undefined; isError?: boolean },
  /** useActiveYear: the flow is the active year's. */
  year: { activeYear: { id: "y-1" } } as {
    activeYear: { id: string } | null;
    isLoading?: boolean;
    isError?: boolean;
  },
}));

const GROUPS = [
  { id: "g-4a", name: "4A" },
  { id: "g-4b", name: "4B" },
];

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useLunchServings: () => state.servings,
  useLunchSettings: () => state.lunch,
  useActiveYear: () => state.year,
  useLunchSittings: () => state.sittings,
  useGroups: () => ({ data: GROUPS }),
  useCrudMutations: () => ({
    create: { mutateAsync: createMock, isPending: false },
    update: { mutateAsync: updateMock, isPending: false },
    remove: { mutateAsync: removeMock, isPending: false },
  }),
}));

// next-intl's navigation helpers do not resolve under jsdom; the page only
// needs a link that renders its text.
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const serving = (
  id: string,
  min: number,
  max: number,
  dayOfWeek: number | null,
  start: string,
  end: string,
  seats: number | null = null,
): ServingFixture => ({
  id,
  minGradeLevel: min,
  maxGradeLevel: max,
  dayOfWeek,
  startTime: `${start}:00`,
  endTime: `${end}:00`,
  seats,
});

/** A school that has defined lunch: 30 minutes, so a sitting can be too short. */
const LUNCH = { lunchEnabled: true, lunchMinutes: 30 };

beforeEach(() => {
  createMock.mockReset().mockResolvedValue({});
  updateMock.mockReset().mockResolvedValue({});
  removeMock.mockReset().mockResolvedValue({});
  state.servings = { data: [], isLoading: false };
  state.lunch = { data: LUNCH };
  state.sittings = { data: [] };
  state.year = { activeYear: { id: "y-1" }, isLoading: false, isError: false };
});

/** The flow, as "stage | mon | tue | wed | thu | fri". */
const flowRows = () =>
  within(screen.getByRole("region", { name: "windowsTitle" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent).join(" | "),
    );

// ---------------------------------------------------------------------------
// The flow the rows make
// ---------------------------------------------------------------------------

describe("the computed flow", () => {
  it("is not offered at all before anything is declared", () => {
    render(<LunchServingsPage />);
    expect(screen.queryByRole("region", { name: "windowsTitle" })).toBeNull();
    expect(screen.getByText("empty")).toBeTruthy();
  });

  it("shows an every-day sitting on every weekday", () => {
    state.servings = { data: [serving("a", 4, 6, null, "11:40", "12:20")], isLoading: false };
    render(<LunchServingsPage />);

    expect(flowRows()).toEqual([
      "grade(4)–grade(6) | 11:40–12:20 | 11:40–12:20 | 11:40–12:20 | 11:40–12:20 | 11:40–12:20",
    ]);
  });

  it("shows a weekday row replacing the every-day one, not widening it", () => {
    /*
     * The reason this table exists. Two rows in the list above are one sentence
     * in the school's head, and only here can they check the app read it their
     * way — a union would show Friday as 11:40–13:00.
     */
    state.servings = {
      data: [serving("all", 7, 9, null, "12:20", "13:00"), serving("fri", 7, 9, 5, "11:40", "12:20")],
      isLoading: false,
    };
    render(<LunchServingsPage />);

    expect(flowRows()[0]).toBe(
      "grade(7)–grade(9) | 12:20–13:00 | 12:20–13:00 | 12:20–13:00 | 12:20–13:00 | 11:40–12:20",
    );
  });

  it("shows both waves a school wrote for one stage", () => {
    state.servings = {
      data: [serving("a", 7, 9, null, "11:40", "12:10"), serving("b", 7, 9, null, "12:20", "12:50")],
      isLoading: false,
    };
    render(<LunchServingsPage />);

    expect(flowRows()[0]).toContain("11:40–12:10");
    expect(flowRows()[0]).toContain("12:20–12:50");
  });

  it("leaves a stage no sitting reaches on the whole lunch window", () => {
    state.servings = { data: [serving("a", 4, 6, 1, "11:40", "12:20")], isLoading: false };
    render(<LunchServingsPage />);

    expect(flowRows()[0]).toBe(
      "grade(4)–grade(6) | 11:40–12:20 | flowOpen | flowOpen | flowOpen | flowOpen",
    );
  });

  it("marks a sitting shorter than the meal", () => {
    // The list above shows an innocent row; only the flow says nobody can eat
    // in it. The engine refuses this at generation time, which is far later.
    state.servings = { data: [serving("a", 4, 6, null, "11:00", "11:20")], isLoading: false };
    render(<LunchServingsPage />);

    expect(flowRows()[0]).toContain("tooShort(30)");
  });

  it("does not call a sitting too short when no lunch length is known", () => {
    // Without a lunch there is nothing to be shorter than, and a red badge
    // against an unknown would be a guess.
    state.lunch = { data: { lunchEnabled: false, lunchMinutes: 30 } };
    state.servings = { data: [serving("a", 4, 6, null, "11:00", "11:20")], isLoading: false };
    render(<LunchServingsPage />);

    expect(flowRows()[0]).not.toContain("tooShort");
  });

  it("gives one row per stage, in year order", () => {
    state.servings = {
      data: [serving("b", 7, 9, null, "12:20", "13:00"), serving("a", 0, 3, null, "11:00", "11:40")],
      isLoading: false,
    };
    render(<LunchServingsPage />);

    expect(flowRows().map((row) => row.split(" | ")[0])).toEqual([
      "grade(0)–grade(3)",
      "grade(7)–grade(9)",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The kitchen's list
// ---------------------------------------------------------------------------

describe("the kitchen's flow", () => {
  const sitting = (
    id: string,
    groupId: string,
    dayOfWeek: number,
    start: string,
    end: string,
    headcount: number,
  ) => ({
    id,
    studentGroupId: groupId,
    dayOfWeek,
    startTime: `${start}:00`,
    endTime: `${end}:00`,
    headcount,
  });

  it("says in a sentence that it waits for a generation run, and draws no list", () => {
    // Not an empty list: a printable list with nothing on it invites somebody
    // to take it to the kitchen. But not silence either — the section used to
    // be absent, so nothing said where the kitchen's list would appear or why
    // it was not there yet (lunchServings.flowEmpty was written and never shown).
    state.servings = { data: [serving("a", 4, 6, null, "11:00", "11:40")], isLoading: false };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    expect(within(region).getByText("flowEmpty")).toBeTruthy();
    expect(within(region).queryByRole("list")).toBeNull();
  });

  it("says the years could not be read rather than that no schedule is generated", () => {
    state.year = { activeYear: null, isLoading: false, isError: true };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    const notice = within(region).getByRole("alert");
    expect(notice).toHaveTextContent("flowLoadFailed");
    expect(notice).toHaveTextContent("flowYearsLoadFailedHint");
    expect(within(region).queryByText("flowEmpty")).toBeNull();
  });

  it("says there is no active year rather than that no schedule is generated", () => {
    state.year = { activeYear: null, isLoading: false, isError: false };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    expect(within(region).getByText("flowNoYear")).toBeTruthy();
    expect(within(region).queryByText("flowEmpty")).toBeNull();
  });

  it("waits for the years rather than saying anything about the flow", () => {
    state.year = { activeYear: null, isLoading: true, isError: false };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    expect(region.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(within(region).queryByText("flowEmpty")).toBeNull();
    expect(within(region).queryByText("flowNoYear")).toBeNull();
  });

  it("keeps the flow it has read when a refetch fails, and says so above it", () => {
    state.sittings = { data: [sitting("s1", "g-4a", 1, "11:00", "11:30", 28)], isError: true };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    const notice = within(region).getByRole("alert");
    expect(notice).toHaveTextContent("flowLoadFailed");
    expect(notice).toHaveTextContent("refetchFailedHint");
    expect(within(region).getByText(/4A/)).toBeTruthy();
  });

  it("names the classes, not their ids", () => {
    state.sittings = { data: [sitting("s1", "g-4a", 1, "11:00", "11:30", 28)] };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    expect(within(region).getByText(/4A/)).toBeTruthy();
    expect(within(region).queryByText(/g-4a/)).toBeNull();
  });

  it("puts two classes that sit down together on one line", () => {
    state.sittings = {
      data: [
        sitting("s1", "g-4a", 1, "11:00", "11:30", 28),
        sitting("s2", "g-4b", 1, "11:00", "11:30", 30),
      ],
    };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    expect(within(region).getByText(/4A, 4B/)).toBeTruthy();
    expect(within(region).getByText("flowSeated(58)")).toBeTruthy();
  });

  it("reports the peak in the hall, not the sum of the waves", () => {
    // Two waves that never meet must not be added: whether the hall is big
    // enough is a question about one moment.
    state.sittings = {
      data: [
        sitting("s1", "g-4a", 1, "11:00", "11:30", 28),
        sitting("s2", "g-4b", 1, "11:30", "12:00", 30),
      ],
    };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    expect(within(region).getByText("flowTotal(30)")).toBeTruthy();
  });

  it("gives each weekday its own card", () => {
    state.sittings = {
      data: [
        sitting("s1", "g-4a", 1, "11:00", "11:30", 28),
        sitting("s2", "g-4a", 5, "11:40", "12:10", 28),
      ],
    };
    render(<LunchServingsPage />);

    const region = screen.getByRole("region", { name: "flowTitle" });
    // The mock echoes the key, and tDays is called with the bare weekday.
    expect(
      within(region).getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["1", "5"]);
  });
});

// ---------------------------------------------------------------------------
// The warning that the rows mean nothing yet// ---------------------------------------------------------------------------
// The warning that the rows mean nothing yet
// ---------------------------------------------------------------------------

describe("when lunch is not defined", () => {
  it("says so, because the sittings then constrain nothing", () => {
    state.lunch = { data: null };
    render(<LunchServingsPage />);

    expect(screen.getByRole("status")).toHaveTextContent("noLunch");
  });

  it("says so when lunch exists but is switched off", () => {
    state.lunch = { data: { lunchEnabled: false, lunchMinutes: 30 } };
    render(<LunchServingsPage />);

    expect(screen.getByRole("status")).toHaveTextContent("noLunch");
  });

  it("stays quiet once lunch is defined", () => {
    render(<LunchServingsPage />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing about lunch while the school rules are still on their way", () => {
    // The banner used to show before the rules had answered, telling a school
    // with a perfectly good lunch that it had none.
    state.lunch = { data: undefined };
    render(<LunchServingsPage />);

    expect(screen.queryByText("noLunch")).toBeNull();
  });

  it("says the lunch could not be read rather than that it is undefined", () => {
    state.lunch = { data: undefined, isError: true };
    render(<LunchServingsPage />);

    expect(screen.queryByText("noLunch")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("lunchLoadFailed");
  });

  it("links to the school rules section itself, not the top of Tillgänglighet", () => {
    state.lunch = { data: null };
    render(<LunchServingsPage />);

    expect(screen.getByRole("link", { name: "lunchLink" }).getAttribute("href")).toBe(
      "/admin/constraints#skolregler",
    );
  });
});

describe("while the sittings are not known", () => {
  it("says the fetch failed instead of claiming every stage eats at once", () => {
    state.servings = { data: undefined, isLoading: false, isError: true };
    render(<LunchServingsPage />);

    expect(screen.getByRole("alert")).toHaveTextContent("loadFailed");
    expect(screen.queryByText("emptyTitle")).toBeNull();
  });

  it("keeps the sittings it has read when a refetch fails, and says so above them", () => {
    // Every save invalidates the list; a background read that fails must not
    // take away the rows the admin is working on.
    state.servings = {
      data: [serving("a", 4, 6, 5, "11:40", "12:20")],
      isLoading: false,
      isError: true,
    };
    render(<LunchServingsPage />);

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("loadFailed");
    expect(notice).toHaveTextContent("refetchFailedHint");
    expect(
      screen.getByRole("button", { name: "actionNamed(delete|grade(4)–grade(6), 5 11:40–12:20)" }),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "loadFailed" })).toBeNull();
  });

  it("shows a skeleton, not the empty state, while they load", () => {
    state.servings = { data: undefined, isLoading: true };
    render(<LunchServingsPage />);

    expect(screen.queryByText("emptyTitle")).toBeNull();
    expect(document.querySelector(".animate-pulse")).not.toBeNull();
  });
});

describe("removing a sitting", () => {
  it("names the row on its buttons and asks, with the verb, before it removes it", async () => {
    state.servings = { data: [serving("a", 4, 6, 5, "11:40", "12:20")], isLoading: false };
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await user.click(screen.getByRole("button", { name: "actionNamed(delete|grade(4)–grade(6), 5 11:40–12:20)" }));
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByText("deleteBody(grade(4)–grade(6), 5 11:40–12:20)")).toBeTruthy();
    expect(removeMock).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole("button", { name: "delete" }));
    expect(removeMock).toHaveBeenCalledWith("a");
  });
});

// ---------------------------------------------------------------------------
// What gets sent
// ---------------------------------------------------------------------------

describe("saving a sitting", () => {
  const open = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: "add" }));
  const save = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: "save" }));

  it("sends the every-day sitting as null, not as the select's sentinel", async () => {
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await open(user);
    await save(user);

    expect(createMock).toHaveBeenCalledWith({
      minGradeLevel: 4,
      maxGradeLevel: 6,
      dayOfWeek: null,
      startTime: "11:00",
      endTime: "11:40",
      seats: null,
    });
  });

  it("drags the upper bound along when the lower one passes it", async () => {
    /*
     * A stage that reads backwards was never what anybody meant, and the
     * service refuses it after the fact. The pair is corrected as it is typed
     * — and since the two selects moved onto components/ui/grade-span-field,
     * that rule lives somewhere this page does not own. Asserted here so a
     * change over there cannot quietly hand the kitchen an empty sitting.
     */
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await open(user);
    await user.click(screen.getByRole("combobox", { name: "gradeFromLabel" }));
    await user.click(await screen.findByRole("option", { name: "grade(9)" }));
    await save(user);

    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      minGradeLevel: 9,
      maxGradeLevel: 9,
    });
  });

  it("drags the lower bound along when the upper one falls below it", async () => {
    // The other direction, which nothing covered.
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await open(user);
    await user.click(screen.getByRole("combobox", { name: "gradeToLabel" }));
    await user.click(await screen.findByRole("option", { name: "grade(1)" }));
    await save(user);

    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      minGradeLevel: 1,
      maxGradeLevel: 1,
    });
  });

  it("sends an empty seat field as null, not as zero", async () => {
    /*
     * Number("") is 0, and the API refuses a sitting for nobody. An empty field
     * is the admin leaving the hall's own limit in place.
     */
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await open(user);
    await save(user);

    expect(createMock.mock.calls[0]?.[0].seats).toBeNull();
  });

  it("sends a seat count the sitting was given, as a number", async () => {
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await open(user);
    await user.type(screen.getByLabelText("seats"), "90");
    await save(user);

    expect(createMock.mock.calls[0]?.[0].seats).toBe(90);
  });

  it("refuses to save a window that ends before it starts", async () => {
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await open(user);
    const start = screen.getByLabelText("startTime");
    await user.clear(start);
    await user.type(start, "13:00");

    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("loads a stored sitting into the form as HH:MM", async () => {
    state.servings = { data: [serving("a", 4, 6, 3, "11:40", "12:20", 90)], isLoading: false };
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await user.click(screen.getAllByRole("button", { name: /^actionNamed\(edit\|/ })[0]!);

    expect(screen.getByLabelText("startTime")).toHaveValue("11:40");
    expect(screen.getByLabelText("endTime")).toHaveValue("12:20");
    expect(screen.getByLabelText("seats")).toHaveValue(90);
  });

  it("loads a sitting with no seat count as an empty field", async () => {
    state.servings = { data: [serving("a", 4, 6, null, "11:40", "12:20")], isLoading: false };
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await user.click(screen.getAllByRole("button", { name: /^actionNamed\(edit\|/ })[0]!);

    expect(screen.getByLabelText("seats")).toHaveValue(null);
  });

  it("sends a weekday sitting as its number", async () => {
    state.servings = { data: [serving("a", 4, 6, 5, "11:40", "12:20")], isLoading: false };
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await user.click(screen.getAllByRole("button", { name: /^actionNamed\(edit\|/ })[0]!);
    await save(user);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", dayOfWeek: 5 }),
    );
  });
});
