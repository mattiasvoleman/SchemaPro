import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FrameTimesPage from "./page";

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
 * The list of rows is the easy half. The hard half is the week the rows ADD UP
 * TO: frames reaching the same stage all apply at once, so a weekday row
 * silently narrows an every-day one, and a school straddling two stages gets
 * the tighter of them. None of that is visible in a list, which is why the page
 * computes it back — and a computed table that is wrong is worse than no table,
 * because it looks like an answer.
 *
 * lib/frame-times.ts is NOT mocked here. The interesting failure is the page
 * computing the week with its own second implementation that disagrees with the
 * one conflicts.ts and gaps.ts read, and a mocked module cannot show that.
 *
 * The other half is what gets SENT. `dayOfWeek` is null for the every-day
 * frame, and a Select cannot hold null — so the sentinel has to be converted
 * back on the way out, and a form that sends the string "all" fails only
 * against a real API.
 */

interface FrameFixture {
  id: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
}

const createMock = vi.fn();
const updateMock = vi.fn();
const removeMock = vi.fn();

const state = vi.hoisted(() => ({
  frames: { data: [] as unknown[], isLoading: false },
}));

vi.mock("@/lib/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries")>()),
  useFrameTimes: () => state.frames,
  useCrudMutations: () => ({
    create: { mutateAsync: createMock, isPending: false },
    update: { mutateAsync: updateMock, isPending: false },
    remove: { mutateAsync: removeMock, isPending: false },
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const frame = (
  id: string,
  minGradeLevel: number,
  maxGradeLevel: number,
  dayOfWeek: number | null,
  startTime: string,
  endTime: string,
): FrameFixture => ({
  id,
  minGradeLevel,
  maxGradeLevel,
  dayOfWeek,
  startTime: `${startTime}:00`,
  endTime: `${endTime}:00`,
});

beforeEach(() => {
  createMock.mockReset().mockResolvedValue({});
  updateMock.mockReset().mockResolvedValue({});
  removeMock.mockReset().mockResolvedValue({});
  state.frames = { data: [], isLoading: false };
});

/** The computed week, as "stage | mon | tue | wed | thu | fri". */
const weekRows = () =>
  within(screen.getByRole("region", { name: "effectiveTitle" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent).join(" | "),
    );

// ---------------------------------------------------------------------------
// The week the rows add up to
// ---------------------------------------------------------------------------

describe("the computed week", () => {
  it("is not offered at all when there are no frames", () => {
    render(<FrameTimesPage />);
    expect(screen.queryByRole("region", { name: "effectiveTitle" })).toBeNull();
  });

  it("shows an every-day frame on every weekday", () => {
    state.frames = { data: [frame("f1", 4, 6, null, "08:00", "15:00")], isLoading: false };
    render(<FrameTimesPage />);

    expect(weekRows()).toEqual([
      "grade(4)–grade(6) | 08:00–15:00 | 08:00–15:00 | 08:00–15:00 | 08:00–15:00 | 08:00–15:00",
    ]);
  });

  it("shows a weekday frame narrowing the every-day one", () => {
    /*
     * The reason this table exists. "08:00-15:00 always" and "08:00-13:00 on
     * Friday" are two rows in the list above and one sentence in the school's
     * head; only here can they check that the app read it their way.
     */
    state.frames = {
      data: [frame("f1", 4, 6, null, "08:00", "15:00"), frame("f2", 4, 6, 5, "08:00", "13:00")],
      isLoading: false,
    };
    render(<FrameTimesPage />);

    expect(weekRows()).toEqual([
      "grade(4)–grade(6) | 08:00–15:00 | 08:00–15:00 | 08:00–15:00 | 08:00–15:00 | 08:00–13:00",
    ]);
  });

  it("leaves a day no frame touches as the whole day", () => {
    state.frames = { data: [frame("f1", 4, 6, 1, "08:00", "15:00")], isLoading: false };
    render(<FrameTimesPage />);

    expect(weekRows()[0]).toBe(
      "grade(4)–grade(6) | 08:00–15:00 | wholeDay | wholeDay | wholeDay | wholeDay",
    );
  });

  it("says closed rather than showing a backwards window", () => {
    // Two frames for the same stage that cannot both hold. The list above shows
    // two innocent rows; only the computed week says the day is gone.
    state.frames = {
      data: [frame("f1", 4, 6, 1, "08:00", "10:00"), frame("f2", 4, 6, 1, "14:00", "16:00")],
      isLoading: false,
    };
    render(<FrameTimesPage />);

    expect(weekRows()[0]).toContain("closed");
  });

  it("gives one row per stage the school has written about", () => {
    state.frames = {
      data: [frame("f2", 7, 9, null, "08:00", "16:00"), frame("f1", 0, 3, null, "08:00", "13:00")],
      isLoading: false,
    };
    render(<FrameTimesPage />);

    // Year order, not the order the rows arrived in.
    expect(weekRows().map((row) => row.split(" | ")[0])).toEqual([
      "grade(0)–grade(3)",
      "grade(7)–grade(9)",
    ]);
  });

  it("names a single-year stage as one year, not as a range", () => {
    state.frames = { data: [frame("f1", 4, 4, null, "08:00", "15:00")], isLoading: false };
    render(<FrameTimesPage />);

    expect(weekRows()[0]?.startsWith("grade(4) |")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What gets sent
// ---------------------------------------------------------------------------

describe("saving a frame", () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "add" }));
  };

  const save = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "save" }));
  };

  it("sends the every-day frame as null, not as the select's sentinel", async () => {
    /*
     * A Select cannot hold null, so the page carries a string for it. Sending
     * that string through is a 400 the admin sees as "something went wrong",
     * and it is invisible in every rendered assertion.
     */
    const user = userEvent.setup();
    render(<FrameTimesPage />);

    await open(user);
    await save(user);

    expect(createMock).toHaveBeenCalledWith({
      minGradeLevel: 4,
      maxGradeLevel: 6,
      dayOfWeek: null,
      startTime: "08:00",
      endTime: "15:00",
    });
  });

  it("sends the years as numbers, which is what the DTO validates", async () => {
    const user = userEvent.setup();
    render(<FrameTimesPage />);

    await open(user);
    await save(user);

    const body = createMock.mock.calls[0]?.[0];
    expect(typeof body.minGradeLevel).toBe("number");
    expect(typeof body.maxGradeLevel).toBe("number");
  });

  it("refuses to save a window that ends before it starts", async () => {
    const user = userEvent.setup();
    render(<FrameTimesPage />);

    await open(user);
    const start = screen.getByLabelText("startTime");
    await user.clear(start);
    await user.type(start, "16:00");

    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    expect(createMock).not.toHaveBeenCalled();
  });

  it("names the row a duplicate would collide with before the save is tried", async () => {
    /*
     * One frame per stage per weekday, enforced by a unique index — so without
     * this the second save comes back as a database conflict nobody can read.
     */
    state.frames = { data: [frame("f1", 4, 6, null, "08:00", "15:00")], isLoading: false };
    const user = userEvent.setup();
    render(<FrameTimesPage />);

    await open(user);

    expect(screen.getByRole("status")).toHaveTextContent("duplicate");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("does not call a frame a duplicate of itself while editing it", async () => {
    const existing = frame("f1", 4, 6, null, "08:00", "15:00");
    state.frames = { data: [existing], isLoading: false };
    const user = userEvent.setup();
    render(<FrameTimesPage />);

    await user.click(screen.getAllByRole("button", { name: "edit" })[0]!);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "save" })).not.toBeDisabled();
  });

  it("loads the stored clock into the form as HH:MM", async () => {
    // The row carries HH:MM:SS; an <input type="time"> that gets the seconds
    // back renders empty in some browsers and is the 1970 bug's near neighbour.
    state.frames = { data: [frame("f1", 4, 6, 3, "09:30", "14:45")], isLoading: false };
    const user = userEvent.setup();
    render(<FrameTimesPage />);

    await user.click(screen.getAllByRole("button", { name: "edit" })[0]!);

    expect(screen.getByLabelText("startTime")).toHaveValue("09:30");
    expect(screen.getByLabelText("endTime")).toHaveValue("14:45");
  });

  it("sends a weekday frame as its number", async () => {
    state.frames = { data: [frame("f1", 4, 6, 5, "08:00", "13:00")], isLoading: false };
    const user = userEvent.setup();
    render(<FrameTimesPage />);

    await user.click(screen.getAllByRole("button", { name: "edit" })[0]!);
    await save(user);

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "f1", dayOfWeek: 5 }),
    );
  });
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe("the list", () => {
  it("offers the empty state, and no computed week, before anything is written", () => {
    render(<FrameTimesPage />);
    expect(screen.getByText("empty")).toBeTruthy();
  });

  it("marks the every-day frame rather than leaving its day blank", () => {
    state.frames = { data: [frame("f1", 4, 6, null, "08:00", "15:00")], isLoading: false };
    render(<FrameTimesPage />);

    const row = screen.getAllByRole("row")[1]!;
    expect(within(row).getByText("everyDay")).toBeTruthy();
  });

  it("shows the clock without its seconds", () => {
    state.frames = { data: [frame("f1", 4, 6, 1, "08:00", "15:00")], isLoading: false };
    render(<FrameTimesPage />);

    const row = screen.getAllByRole("row")[1]!;
    expect([...row.querySelectorAll("td")].map((cell) => cell.textContent)).toContain(
      "08:00–15:00",
    );
  });
});
