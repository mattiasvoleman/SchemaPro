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
  servings: { data: [] as unknown[], isLoading: false },
  lunch: { data: null as unknown },
}));

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useLunchServings: () => state.servings,
  useLunchSettings: () => state.lunch,
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
});

/** The flow, as "stage | mon | tue | wed | thu | fri". */
const flowRows = () =>
  within(screen.getByRole("region", { name: "flowTitle" }))
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
    expect(screen.queryByRole("region", { name: "flowTitle" })).toBeNull();
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

    await user.click(screen.getAllByRole("button", { name: "edit" })[0]!);

    expect(screen.getByLabelText("startTime")).toHaveValue("11:40");
    expect(screen.getByLabelText("endTime")).toHaveValue("12:20");
    expect(screen.getByLabelText("seats")).toHaveValue(90);
  });

  it("loads a sitting with no seat count as an empty field", async () => {
    state.servings = { data: [serving("a", 4, 6, null, "11:40", "12:20")], isLoading: false };
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await user.click(screen.getAllByRole("button", { name: "edit" })[0]!);

    expect(screen.getByLabelText("seats")).toHaveValue(null);
  });

  it("sends a weekday sitting as its number", async () => {
    state.servings = { data: [serving("a", 4, 6, 5, "11:40", "12:20")], isLoading: false };
    const user = userEvent.setup();
    render(<LunchServingsPage />);

    await user.click(screen.getAllByRole("button", { name: "edit" })[0]!);
    await save(user);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", dayOfWeek: 5 }),
    );
  });
});
