import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimetableGrid, type TimetableBand, type TimetableLesson } from "./timetable-grid";

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

function makeLesson(overrides: Partial<TimetableLesson> = {}): TimetableLesson {
  return {
    id: "math-mon",
    dayOfWeek: 1,
    startMinutes: 540, // 09:00
    endMinutes: 600, // 10:00
    title: "Math",
    color: "#6366f1",
    ...overrides,
  };
}

/**
 * jsdom has no layout, so all getBoundingClientRect calls return zeros and the
 * pointer-to-grid conversion (`locate`) would bail out. For the pointer tests
 * we pin a deterministic geometry instead: 56px time axis + 5 day columns of
 * 100px each (right edge 556), and the default 08:00-16:00 window, which is
 * 480 minutes at 1.1 px/min = 528px tall.
 *
 * With this rect: day = floor((clientX - 56) / 100) + 1 and
 * minute = 480 + clientY / 1.1. The mock applies to every element, so the
 * lesson button's bottom edge is also y=528 - a pointerdown with
 * clientY >= 520 lands in the 8px resize handle, anything higher is a move.
 */
const GRID_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 556,
  bottom: 528,
  width: 556,
  height: 528,
  toJSON: () => ({}),
} as DOMRect;

function mockGridGeometry() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(GRID_RECT);
}

const pointerDown = (element: Element, init: PointerEventInit) =>
  fireEvent.pointerDown(element, { pointerId: 1, button: 0, ...init });
const pointerMove = (init: PointerEventInit) =>
  fireEvent.pointerMove(window, { pointerId: 1, ...init });
const pointerUp = (init: PointerEventInit = {}) =>
  fireEvent.pointerUp(window, { pointerId: 1, ...init });

// The drag ghost is a decorative, pointer-events-none overlay with no role or
// text handle beyond its time range, so we locate it by its distinctive
// dashed-border class.
const queryGhost = (container: HTMLElement) =>
  container.querySelector('[class*="border-dashed"]');

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TimetableGrid day columns", () => {
  it("renders Monday-Friday when no lesson falls on a weekend", () => {
    render(<TimetableGrid lessons={[makeLesson({ dayOfWeek: 5 })]} />);

    expect(screen.getByText("monday")).toBeInTheDocument();
    expect(screen.getByText("friday")).toBeInTheDocument();
    expect(screen.queryByText("saturday")).not.toBeInTheDocument();
    expect(screen.queryByText("sunday")).not.toBeInTheDocument();
  });

  it("extends to seven days when a lesson falls on a weekend", () => {
    render(<TimetableGrid lessons={[makeLesson({ dayOfWeek: 6 })]} />);

    expect(screen.getByText("saturday")).toBeInTheDocument();
    expect(screen.getByText("sunday")).toBeInTheDocument();
  });

  it("renders an empty 5-day grid with no lesson buttons when there are no lessons", () => {
    render(<TimetableGrid lessons={[]} />);

    expect(screen.getByText("monday")).toBeInTheDocument();
    expect(screen.queryByText("saturday")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("TimetableGrid time axis and vertical placement", () => {
  it("labels interior hours of the default 08:00-16:00 window, omitting both edges", () => {
    render(<TimetableGrid lessons={[makeLesson()]} />);

    expect(screen.getByText("09:00")).toBeInTheDocument();
    expect(screen.getByText("15:00")).toBeInTheDocument();
    expect(screen.queryByText("08:00")).not.toBeInTheDocument();
    expect(screen.queryByText("16:00")).not.toBeInTheDocument();
  });

  it("positions a lesson from its start time and duration", () => {
    render(<TimetableGrid lessons={[makeLesson()]} />);

    // 09:00 with an 08:00 grid start: (540 - 480) * 1.1px = 66px down,
    // 60 minutes tall: 66px.
    const button = screen.getByRole("button", { name: /Math/ });
    expect(button.style.top).toBe("66px");
    expect(button.style.height).toBe("66px");
  });

  it("clamps very short lessons to a minimum readable height", () => {
    render(
      <TimetableGrid lessons={[makeLesson({ startMinutes: 540, endMinutes: 555 })]} />,
    );

    // 15 minutes would be 16.5px; the floor is 28px.
    expect(screen.getByRole("button", { name: /Math/ }).style.height).toBe("28px");
  });

  it("widens the hour window to fit early and late lessons", () => {
    render(
      <TimetableGrid
        lessons={[makeLesson({ startMinutes: 435, endMinutes: 1050 })]} // 07:15-17:30
      />,
    );

    // Window becomes 07:00-18:00, so 08:00 and 17:00 gain labels while the
    // new edges stay unlabelled.
    expect(screen.getByText("08:00")).toBeInTheDocument();
    expect(screen.getByText("17:00")).toBeInTheDocument();
    expect(screen.queryByText("07:00")).not.toBeInTheDocument();
    expect(screen.queryByText("18:00")).not.toBeInTheDocument();

    // Placement is now relative to the 07:00 start: (435 - 420) * 1.1 = 16.5px.
    expect(screen.getByRole("button", { name: /Math/ }).style.top).toBe("16.5px");
  });
});

describe("TimetableGrid overlap lanes", () => {
  it("splits overlapping lessons into side-by-side lanes", () => {
    render(
      <TimetableGrid
        lessons={[
          makeLesson({ id: "a", title: "Algebra", startMinutes: 540, endMinutes: 600 }),
          makeLesson({ id: "b", title: "Biology", startMinutes: 570, endMinutes: 630 }),
        ]}
      />,
    );

    const algebra = screen.getByRole("button", { name: /Algebra/ });
    const biology = screen.getByRole("button", { name: /Biology/ });
    expect(algebra.style.left).toBe("calc(0% + 3px)");
    expect(algebra.style.width).toBe("calc(50% - 6px)");
    expect(biology.style.left).toBe("calc(50% + 3px)");
    expect(biology.style.width).toBe("calc(50% - 6px)");
  });

  it("prints the share badge without taking a lane for it", () => {
    render(
      <TimetableGrid
        lessons={[
          makeLesson({
            id: "a",
            title: "Algebra",
            share: "2/4",
            shareLabel: "2 av 4 elever i 4.1",
          }),
        ]}
      />,
    );

    const algebra = screen.getByRole("button", { name: /Algebra/ });
    expect(algebra.textContent).toContain("2/4");
    // Spelled out for a reader who cannot see it. "2/4" alone is a riddle.
    expect(algebra.textContent).toContain("2 av 4 elever i 4.1");
    // And still the whole column. layoutDay applies ONE laneCount to a whole
    // day, so a lane for these badges would narrow every card on the day —
    // which is the same reason the lunch bands are drawn behind the lessons
    // rather than beside them.
    expect(algebra.style.width).toBe("calc(100% - 6px)");
  });

  it("lets back-to-back lessons share a full-width lane", () => {
    render(
      <TimetableGrid
        lessons={[
          makeLesson({ id: "a", title: "Algebra", startMinutes: 540, endMinutes: 600 }),
          makeLesson({ id: "b", title: "Biology", startMinutes: 600, endMinutes: 660 }),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /Algebra/ }).style.width).toBe(
      "calc(100% - 6px)",
    );
    expect(screen.getByRole("button", { name: /Biology/ }).style.left).toBe(
      "calc(0% + 3px)",
    );
  });

  it("applies the day's lane count even to lessons that overlap nothing (pins current behaviour)", () => {
    // layoutDay computes one laneCount for the whole day, so a lesson far away
    // from the overlapping pair is still narrowed to 50%. Pinned deliberately:
    // per-cluster widths would be a behaviour change, not a bugfix.
    render(
      <TimetableGrid
        lessons={[
          makeLesson({ id: "a", title: "Algebra", startMinutes: 540, endMinutes: 600 }),
          makeLesson({ id: "b", title: "Biology", startMinutes: 570, endMinutes: 630 }),
          makeLesson({ id: "c", title: "Chemistry", startMinutes: 700, endMinutes: 760 }),
        ]}
      />,
    );

    const chemistry = screen.getByRole("button", { name: /Chemistry/ });
    expect(chemistry.style.width).toBe("calc(50% - 6px)");
    expect(chemistry.style.left).toBe("calc(0% + 3px)");
  });
});

describe("TimetableGrid lesson appearance", () => {
  it("derives the tint, accent border and title color from the subject color", () => {
    render(<TimetableGrid lessons={[makeLesson({ color: "#6366f1" })]} />);

    const button = screen.getByRole("button", { name: /Math/ });
    // #6366f1 + "1a" alpha suffix for the tint.
    expect(button).toHaveStyle({
      backgroundColor: "rgba(99, 102, 241, 0.1)",
      borderLeftColor: "#6366f1",
    });
    expect(screen.getByText("Math")).toHaveStyle({ color: "#6366f1" });
  });

  it("renders subtitle and room lines when present", () => {
    render(
      <TimetableGrid lessons={[makeLesson({ subtitle: "Class 9B", room: "Room 214" })]} />,
    );

    expect(screen.getByText("Class 9B")).toBeInTheDocument();
    expect(screen.getByText("Room 214")).toBeInTheDocument();
  });

  it("strikes through and fades cancelled lessons", () => {
    render(<TimetableGrid lessons={[makeLesson({ cancelled: true })]} />);

    const button = screen.getByRole("button", { name: /Math/ });
    expect(button).toHaveClass("line-through");
    expect(button).toHaveClass("opacity-45");
  });

  it("marks conflicted lessons with a red ring and warning icon", () => {
    const { container } = render(
      <TimetableGrid lessons={[makeLesson({ conflicted: true })]} />,
    );

    expect(screen.getByRole("button", { name: /Math/ })).toHaveClass("ring-2");
    // The lucide icon is decorative (no accessible name), so we fall back to
    // its stable class name.
    expect(container.querySelector("svg.lucide-triangle-alert")).not.toBeNull();
  });

  it("shows a lock badge on pinned lessons", () => {
    const { container } = render(<TimetableGrid lessons={[makeLesson({ locked: true })]} />);

    // Decorative icon, no accessible handle - queried by lucide class.
    expect(container.querySelector("svg.lucide-lock")).not.toBeNull();
  });

  it("shows the remote editor's label as a soft-lock badge", () => {
    render(<TimetableGrid lessons={[makeLesson({ remoteEditor: "Anna B" })]} />);

    const badge = screen.getByTitle("Anna B");
    expect(badge).toHaveTextContent("Anna B");
  });

  it("outlines lessons that are in the current selection", () => {
    render(
      <TimetableGrid
        lessons={[makeLesson(), makeLesson({ id: "other", title: "Physics", dayOfWeek: 2 })]}
        selectedIds={new Set(["math-mon"])}
      />,
    );

    expect(screen.getByRole("button", { name: /Math/ })).toHaveClass("outline-blue-500");
    expect(screen.getByRole("button", { name: /Physics/ })).not.toHaveClass(
      "outline-blue-500",
    );
  });
});

describe("TimetableGrid clicks in read-only mode", () => {
  it("opens a lesson on click", async () => {
    const user = userEvent.setup();
    const onLessonClick = vi.fn();
    render(<TimetableGrid lessons={[makeLesson()]} onLessonClick={onLessonClick} />);

    await user.click(screen.getByRole("button", { name: /Math/ }));

    expect(onLessonClick).toHaveBeenCalledTimes(1);
    // Pins current behaviour: the read-only path passes the internally
    // positioned copy, so the callback also receives lane/laneCount. The
    // editable pointer path passes the original lesson object instead - a
    // minor API inconsistency, reported upstream rather than fixed here.
    expect(onLessonClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "math-mon", lane: 0, laneCount: 1 }),
    );
  });

  it("uses a pointer cursor only when a click would do something", () => {
    const { rerender } = render(
      <TimetableGrid lessons={[makeLesson()]} onLessonClick={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /Math/ })).toHaveClass("cursor-pointer");

    rerender(<TimetableGrid lessons={[makeLesson()]} />);
    expect(screen.getByRole("button", { name: /Math/ })).toHaveClass("cursor-default");
  });
});

describe("TimetableGrid pointer editing", () => {
  it("treats press-and-release without movement as a click on the original lesson", () => {
    mockGridGeometry();
    const lesson = makeLesson();
    const onLessonClick = vi.fn();
    const onLessonChange = vi.fn();
    render(
      <TimetableGrid
        lessons={[lesson]}
        editable
        onLessonClick={onLessonClick}
        onLessonChange={onLessonChange}
      />,
    );

    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    pointerUp({ clientX: 100, clientY: 110 });

    // Exactly the lesson object that was passed in - not the positioned copy.
    expect(onLessonClick).toHaveBeenCalledWith(lesson);
    expect(onLessonChange).not.toHaveBeenCalled();
  });

  it("treats shift+release as a selection toggle instead of opening", () => {
    mockGridGeometry();
    const onLessonClick = vi.fn();
    const onToggleSelect = vi.fn();
    render(
      <TimetableGrid
        lessons={[makeLesson()]}
        editable
        onLessonClick={onLessonClick}
        onToggleSelect={onToggleSelect}
      />,
    );

    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    pointerUp({ clientX: 100, clientY: 110, shiftKey: true });

    expect(onToggleSelect).toHaveBeenCalledWith("math-mon");
    expect(onLessonClick).not.toHaveBeenCalled();
  });

  it("still counts as a click when the pointer wobbles below the drag threshold", () => {
    mockGridGeometry();
    const onLessonClick = vi.fn();
    const onLessonChange = vi.fn();
    render(
      <TimetableGrid
        lessons={[makeLesson()]}
        editable
        onLessonClick={onLessonClick}
        onLessonChange={onLessonChange}
      />,
    );

    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    pointerMove({ clientX: 102, clientY: 111 }); // dx+dy = 3 < 5px threshold
    pointerUp({ clientX: 102, clientY: 111 });

    expect(onLessonClick).toHaveBeenCalledTimes(1);
    expect(onLessonChange).not.toHaveBeenCalled();
  });

  it("shows a snapped ghost during a move drag and commits the new slot on drop", () => {
    mockGridGeometry();
    const onLessonClick = vi.fn();
    const onLessonChange = vi.fn();
    const validateChange = vi.fn().mockReturnValue(true);
    const { container } = render(
      <TimetableGrid
        lessons={[makeLesson()]}
        editable
        onLessonClick={onLessonClick}
        onLessonChange={onLessonChange}
        validateChange={validateChange}
      />,
    );

    // Grab the 09:00 lesson 40 minutes in (clientY 110 -> minute 580),
    // then drag to day 3 at minute 590: start snaps to 590-40 = 550.
    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    pointerMove({ clientX: 300, clientY: 121 });

    const expectedChange = { dayOfWeek: 3, startMinutes: 550, endMinutes: 610 };
    expect(validateChange).toHaveBeenLastCalledWith("math-mon", expectedChange);

    const ghost = queryGhost(container);
    expect(ghost).not.toBeNull();
    expect(ghost).toHaveTextContent("09:10–10:10");
    expect(ghost).toHaveClass("border-emerald-500");
    expect(screen.getByRole("button", { name: /Math/ })).toHaveClass("opacity-40");

    pointerUp({ clientX: 300, clientY: 121 });

    expect(onLessonChange).toHaveBeenCalledTimes(1);
    expect(onLessonChange).toHaveBeenCalledWith("math-mon", expectedChange);
    expect(onLessonClick).not.toHaveBeenCalled();
    expect(queryGhost(container)).toBeNull();
  });

  it("clamps a move drag to the top of the visible day", () => {
    mockGridGeometry();
    const onLessonChange = vi.fn();
    render(
      <TimetableGrid lessons={[makeLesson()]} editable onLessonChange={onLessonChange} />,
    );

    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    pointerMove({ clientX: 100, clientY: 5 }); // would start at 07:25, clamps to 08:00
    pointerUp({ clientX: 100, clientY: 5 });

    expect(onLessonChange).toHaveBeenCalledWith("math-mon", {
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
    });
  });

  it("reports an invalid drop instead of committing it", () => {
    mockGridGeometry();
    const onLessonChange = vi.fn();
    const onInvalidDrop = vi.fn();
    const validateChange = vi.fn().mockReturnValue(false);
    const { container } = render(
      <TimetableGrid
        lessons={[makeLesson()]}
        editable
        onLessonChange={onLessonChange}
        onInvalidDrop={onInvalidDrop}
        validateChange={validateChange}
      />,
    );

    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    pointerMove({ clientX: 300, clientY: 121 });

    expect(queryGhost(container)).toHaveClass("border-red-500");

    pointerUp({ clientX: 300, clientY: 121 });

    expect(onInvalidDrop).toHaveBeenCalledWith("math-mon", {
      dayOfWeek: 3,
      startMinutes: 550,
      endMinutes: 610,
    });
    expect(onLessonChange).not.toHaveBeenCalled();
  });

  it("commits nothing when a moved lesson is dropped back on its original slot", () => {
    mockGridGeometry();
    const onLessonClick = vi.fn();
    const onLessonChange = vi.fn();
    render(
      <TimetableGrid
        lessons={[makeLesson()]}
        editable
        onLessonClick={onLessonClick}
        onLessonChange={onLessonChange}
      />,
    );

    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    // Horizontal wiggle past the threshold within the same day and minute:
    // the ghost equals the origin slot.
    pointerMove({ clientX: 110, clientY: 110 });
    pointerUp({ clientX: 110, clientY: 110 });

    expect(onLessonChange).not.toHaveBeenCalled();
    expect(onLessonClick).not.toHaveBeenCalled(); // it moved, so it is not a click either
  });

  it("cancels an in-flight drag on Escape", () => {
    mockGridGeometry();
    const onLessonClick = vi.fn();
    const onLessonChange = vi.fn();
    const onInvalidDrop = vi.fn();
    const { container } = render(
      <TimetableGrid
        lessons={[makeLesson()]}
        editable
        onLessonClick={onLessonClick}
        onLessonChange={onLessonChange}
        onInvalidDrop={onInvalidDrop}
      />,
    );

    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    pointerMove({ clientX: 300, clientY: 121 });
    expect(queryGhost(container)).not.toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryGhost(container)).toBeNull();

    pointerUp({ clientX: 300, clientY: 121 });

    expect(onLessonChange).not.toHaveBeenCalled();
    expect(onInvalidDrop).not.toHaveBeenCalled();
    expect(onLessonClick).not.toHaveBeenCalled();
  });

  it("resizes from the bottom handle, changing only the end time", () => {
    mockGridGeometry();
    const onLessonChange = vi.fn();
    render(
      <TimetableGrid lessons={[makeLesson()]} editable onLessonChange={onLessonChange} />,
    );

    // clientY 525 is within 8px of the mocked bottom edge (528) -> resize mode.
    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 525 });
    // Pointer wanders into day 3, but a resize keeps the origin day.
    pointerMove({ clientX: 300, clientY: 121 }); // minute 590
    pointerUp({ clientX: 300, clientY: 121 });

    expect(onLessonChange).toHaveBeenCalledWith("math-mon", {
      dayOfWeek: 1,
      startMinutes: 540,
      endMinutes: 590,
    });
  });

  it("clamps a resize between the minimum duration and the end of the day", () => {
    mockGridGeometry();
    const onLessonChange = vi.fn();
    render(
      <TimetableGrid lessons={[makeLesson()]} editable onLessonChange={onLessonChange} />,
    );

    const button = screen.getByRole("button", { name: /Math/ });

    // Drag the end far above the start: clamps to start + 15 minutes.
    pointerDown(button, { clientX: 100, clientY: 525 });
    pointerMove({ clientX: 100, clientY: 20 });
    pointerUp({ clientX: 100, clientY: 20 });
    expect(onLessonChange).toHaveBeenNthCalledWith(1, "math-mon", {
      dayOfWeek: 1,
      startMinutes: 540,
      endMinutes: 555,
    });

    // Drag the end far below the grid: clamps to 16:00 (960).
    pointerDown(button, { clientX: 100, clientY: 525 });
    pointerMove({ clientX: 100, clientY: 700 });
    pointerUp({ clientX: 100, clientY: 700 });
    expect(onLessonChange).toHaveBeenNthCalledWith(2, "math-mon", {
      dayOfWeek: 1,
      startMinutes: 540,
      endMinutes: 960,
    });
  });

  it("ignores pointer editing when not editable", () => {
    mockGridGeometry();
    const onLessonChange = vi.fn();
    render(<TimetableGrid lessons={[makeLesson()]} onLessonChange={onLessonChange} />);

    pointerDown(screen.getByRole("button", { name: /Math/ }), { clientX: 100, clientY: 110 });
    pointerMove({ clientX: 300, clientY: 121 });
    pointerUp({ clientX: 300, clientY: 121 });

    expect(onLessonChange).not.toHaveBeenCalled();
  });
});

describe("TimetableGrid keyboard editing", () => {
  it("moves the lesson 15 minutes with ArrowDown/ArrowUp", () => {
    const onLessonChange = vi.fn();
    render(
      <TimetableGrid lessons={[makeLesson()]} editable onLessonChange={onLessonChange} />,
    );
    const button = screen.getByRole("button", { name: /Math/ });

    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(onLessonChange).toHaveBeenNthCalledWith(1, "math-mon", {
      dayOfWeek: 1,
      startMinutes: 555,
      endMinutes: 615,
    });

    fireEvent.keyDown(button, { key: "ArrowUp" });
    expect(onLessonChange).toHaveBeenNthCalledWith(2, "math-mon", {
      dayOfWeek: 1,
      startMinutes: 525,
      endMinutes: 585,
    });
  });

  it("moves the lesson across days with ArrowRight, clamped at the grid edges", () => {
    const onLessonChange = vi.fn();
    render(
      <TimetableGrid lessons={[makeLesson()]} editable onLessonChange={onLessonChange} />,
    );
    const button = screen.getByRole("button", { name: /Math/ });

    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(onLessonChange).toHaveBeenCalledWith("math-mon", {
      dayOfWeek: 2,
      startMinutes: 540,
      endMinutes: 600,
    });

    // Monday is the first column: ArrowLeft clamps back to day 1, which is a
    // no-op and must not fire a change.
    onLessonChange.mockClear();
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    expect(onLessonChange).not.toHaveBeenCalled();
  });

  it("suppresses no-op moves at the top and bottom of the day", () => {
    const onLessonChange = vi.fn();
    const validateChange = vi.fn().mockReturnValue(true);
    render(
      <TimetableGrid
        lessons={[
          makeLesson({ id: "first", title: "First", startMinutes: 480, endMinutes: 540 }),
          makeLesson({
            id: "last",
            title: "Last",
            dayOfWeek: 2,
            startMinutes: 900,
            endMinutes: 960,
          }),
        ]}
        editable
        onLessonChange={onLessonChange}
        validateChange={validateChange}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: /First/ }), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("button", { name: /Last/ }), { key: "ArrowDown" });

    expect(onLessonChange).not.toHaveBeenCalled();
    expect(validateChange).not.toHaveBeenCalled();
  });

  it("routes rejected keyboard moves to onInvalidDrop", () => {
    const onLessonChange = vi.fn();
    const onInvalidDrop = vi.fn();
    render(
      <TimetableGrid
        lessons={[makeLesson()]}
        editable
        onLessonChange={onLessonChange}
        validateChange={() => false}
        onInvalidDrop={onInvalidDrop}
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: /Math/ }), { key: "ArrowDown" });

    expect(onInvalidDrop).toHaveBeenCalledWith("math-mon", {
      dayOfWeek: 1,
      startMinutes: 555,
      endMinutes: 615,
    });
    expect(onLessonChange).not.toHaveBeenCalled();
  });

  it("opens the editor on Enter and toggles selection on Shift+Space", () => {
    const onLessonClick = vi.fn();
    const onToggleSelect = vi.fn();
    render(
      <TimetableGrid
        lessons={[makeLesson()]}
        editable
        onLessonClick={onLessonClick}
        onToggleSelect={onToggleSelect}
      />,
    );
    const button = screen.getByRole("button", { name: /Math/ });

    fireEvent.keyDown(button, { key: "Enter" });
    expect(onLessonClick).toHaveBeenCalledWith(expect.objectContaining({ id: "math-mon" }));

    fireEvent.keyDown(button, { key: " ", shiftKey: true });
    expect(onToggleSelect).toHaveBeenCalledWith("math-mon");
    expect(onLessonClick).toHaveBeenCalledTimes(1);
  });
});

describe("TimetableGrid empty-slot clicks", () => {
  it("creates a slot at the clicked 15-minute boundary", () => {
    mockGridGeometry();
    const onSlotClick = vi.fn();
    render(<TimetableGrid lessons={[makeLesson()]} editable onSlotClick={onSlotClick} />);

    // The day-column background has no accessible role of its own (it is a
    // pure click target), so we reach it as the lesson button's parent.
    const column = screen.getByRole("button", { name: /Math/ }).parentElement as HTMLElement;

    fireEvent.click(column, { clientX: 100, clientY: 110 }); // minute 580 -> snaps down to 570
    expect(onSlotClick).toHaveBeenCalledWith(1, 570);

    // A click below the last full slot clamps to end-of-day minus the
    // minimum duration (960 - 15).
    fireEvent.click(column, { clientX: 100, clientY: 550 });
    expect(onSlotClick).toHaveBeenLastCalledWith(1, 945);
  });

  it("does not create a slot when the click lands on a lesson", () => {
    mockGridGeometry();
    const onSlotClick = vi.fn();
    render(<TimetableGrid lessons={[makeLesson()]} editable onSlotClick={onSlotClick} />);

    fireEvent.click(screen.getByRole("button", { name: /Math/ }), {
      clientX: 100,
      clientY: 110,
    });

    expect(onSlotClick).not.toHaveBeenCalled();
  });

  it("ignores background clicks when not editable", () => {
    mockGridGeometry();
    const onSlotClick = vi.fn();
    render(<TimetableGrid lessons={[makeLesson()]} onSlotClick={onSlotClick} />);

    const column = screen.getByRole("button", { name: /Math/ }).parentElement as HTMLElement;
    fireEvent.click(column, { clientX: 100, clientY: 110 });

    expect(onSlotClick).not.toHaveBeenCalled();
  });
});

describe("TimetableGrid date headers", () => {
  it("renders day/month under each weekday header and highlights today", () => {
    // Build the dates so that index 0 is today: the highlight must key off
    // calendar identity, not object identity.
    const today = new Date();
    const dates = Array.from(
      { length: 5 },
      (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i),
    );
    const label = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;

    render(<TimetableGrid lessons={[makeLesson()]} dates={dates} />);

    expect(screen.getByText(label(dates[0] as Date))).toHaveClass("text-accent-foreground");
    expect(screen.getByText(label(dates[1] as Date))).not.toHaveClass(
      "text-accent-foreground",
    );
  });

  it("omits the date line entirely when no dates are supplied", () => {
    render(<TimetableGrid lessons={[makeLesson()]} />);

    // No "d/m" text anywhere in the header.
    expect(screen.queryByText(/^\d{1,2}\/\d{1,2}$/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Bands — the lunch drawn behind the lessons
// ---------------------------------------------------------------------------

describe("bands", () => {
  const band = (overrides: Partial<TimetableBand> = {}): TimetableBand => ({
    id: "b1",
    dayOfWeek: 1,
    startMinutes: 11 * 60,
    endMinutes: 11 * 60 + 30,
    label: "Lunch",
    ...overrides,
  });

  it("draws a band on the day it names", () => {
    render(<TimetableGrid lessons={[]} bands={[band()]} />);
    expect(screen.getByText("Lunch")).toBeTruthy();
  });

  it("must never swallow a click meant for the column", () => {
    /*
     * handleSlotClick only fires when event.target === event.currentTarget, so
     * a band without pointer-events-none would kill empty-slot lesson creation
     * across its whole stripe — on exactly the hours a school clicks most.
     * Asserting the class rather than simulating a click, because jsdom
     * dispatches to the element under the cursor regardless of CSS: it cannot
     * see pointer-events at all, so a click test here would pass either way.
     */
    render(<TimetableGrid lessons={[]} bands={[band()]} />);
    const stripe = screen.getByText("Lunch");
    expect(stripe.className).toContain("pointer-events-none");
  });

  it("does not change how wide the lessons are", () => {
    // layoutDay applies ONE laneCount to a whole day, so a band folded into
    // `lessons` would halve every lesson beside it. The lesson's own button
    // carries the inline width, which is the value that would move.
    const lesson = makeLesson({ dayOfWeek: 1 });
    render(<TimetableGrid lessons={[lesson]} />);
    const withoutBand = screen.getByRole("button", { name: /Math/ }).style.width;

    cleanup();
    render(<TimetableGrid lessons={[lesson]} bands={[band()]} />);
    const withBand = screen.getByRole("button", { name: /Math/ }).style.width;

    expect(withBand).toBe(withoutBand);
  });

  it("widens the grid to hold a band outside the default hours", () => {
    // A band has no other affordance to notice its absence by, so a lunch at
    // 07:00 clipped off the top would simply not exist for the reader.
    render(
      <TimetableGrid
        lessons={[]}
        bands={[band({ startMinutes: 7 * 60, endMinutes: 7 * 60 + 30 })]}
      />,
    );

    // The axis leaves its FIRST label blank, so 07:00 itself is never drawn.
    // 08:00 appearing is the evidence the grid now starts an hour earlier —
    // with the default bounds it would be the blank one.
    expect(screen.getByText("08:00")).toBeTruthy();
  });

  it("draws nothing when no bands are given", () => {
    render(<TimetableGrid lessons={[makeLesson({ id: "L1" })]} />);
    expect(screen.queryByText("Lunch")).toBeNull();
  });
});
