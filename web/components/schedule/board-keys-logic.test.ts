import { describe, expect, it } from "vitest";
import {
  focusAfter,
  inReadingOrder,
  lengthened,
  markerAfter,
  sameSquare,
  type Bounds,
  type KeyLesson,
} from "./board-keys-logic";

const lesson = (id: string, dayOfWeek: number, startMinutes: number, endMinutes = startMinutes + 60): KeyLesson => ({
  id,
  dayOfWeek,
  startMinutes,
  endMinutes,
});

// Monday 08:00, 09:30 (and a second at 09:30), 11:00; Tuesday 08:30 and 13:00; Wednesday nothing; Thursday 10:00.
const WEEK = [
  lesson("mon-1", 1, 480),
  lesson("mon-2", 1, 570),
  lesson("mon-2b", 1, 570, 600),
  lesson("mon-3", 1, 660),
  lesson("tue-1", 2, 510),
  lesson("tue-2", 2, 780),
  lesson("thu-1", 4, 600),
];

const BOUNDS: Bounds = { dayCount: 5, dayStartMinutes: 480, dayEndMinutes: 960 };

describe("reading order", () => {
  it("is the day, then the start, then the end, then the id", () => {
    expect(inReadingOrder([...WEEK].reverse()).map((l) => l.id)).toEqual([
      "mon-1",
      "mon-2b",
      "mon-2",
      "mon-3",
      "tue-1",
      "tue-2",
      "thu-1",
    ]);
  });
});

describe("focus", () => {
  it("goes down and up through the day in time order, two side by side one after the other", () => {
    expect(focusAfter(WEEK, "mon-1", "ArrowDown")).toBe("mon-2b");
    expect(focusAfter(WEEK, "mon-2b", "ArrowDown")).toBe("mon-2");
    expect(focusAfter(WEEK, "mon-2", "ArrowDown")).toBe("mon-3");
    expect(focusAfter(WEEK, "mon-3", "ArrowUp")).toBe("mon-2");
  });

  it("stays where it is at the end of a day: no lesson that way is no move", () => {
    expect(focusAfter(WEEK, "mon-3", "ArrowDown")).toBeNull();
    expect(focusAfter(WEEK, "mon-1", "ArrowUp")).toBeNull();
  });

  it("goes to the nearest day with a lesson, and in it to the lesson that starts closest", () => {
    expect(focusAfter(WEEK, "mon-1", "ArrowRight")).toBe("tue-1");
    expect(focusAfter(WEEK, "mon-3", "ArrowRight")).toBe("tue-2");
    // Wednesday is empty: Tuesday goes on to Thursday.
    expect(focusAfter(WEEK, "tue-2", "ArrowRight")).toBe("thu-1");
    expect(focusAfter(WEEK, "thu-1", "ArrowLeft")).toBe("tue-1");
    expect(focusAfter(WEEK, "tue-1", "ArrowLeft")).toBe("mon-1");
    expect(focusAfter(WEEK, "mon-1", "ArrowLeft")).toBeNull();
    expect(focusAfter(WEEK, "thu-1", "ArrowRight")).toBeNull();
  });

  it("takes the earlier of two lessons at the same distance", () => {
    const week = [lesson("a", 1, 600), lesson("early", 2, 540), lesson("late", 2, 660)];
    expect(focusAfter(week, "a", "ArrowRight")).toBe("early");
  });

  it("goes to the first and the last of the day with Home and End", () => {
    expect(focusAfter(WEEK, "mon-2", "Home")).toBe("mon-1");
    expect(focusAfter(WEEK, "mon-2", "End")).toBe("mon-3");
  });

  it("says nothing for a lesson it does not know", () => {
    expect(focusAfter(WEEK, "gone", "ArrowDown")).toBeNull();
  });
});

describe("the marker", () => {
  const at = { dayOfWeek: 2, startMinutes: 600, endMinutes: 660 };

  it("moves a quarter of an hour up and down, five minutes with Shift, and keeps the length", () => {
    expect(markerAfter(at, "ArrowDown", BOUNDS)).toEqual({ dayOfWeek: 2, startMinutes: 615, endMinutes: 675 });
    expect(markerAfter(at, "ArrowUp", BOUNDS)).toEqual({ dayOfWeek: 2, startMinutes: 585, endMinutes: 645 });
    expect(markerAfter(at, "ArrowDown", BOUNDS, true)).toEqual({ dayOfWeek: 2, startMinutes: 605, endMinutes: 665 });
  });

  it("moves a day sideways, and stops at the first and last day", () => {
    expect(markerAfter(at, "ArrowLeft", BOUNDS).dayOfWeek).toBe(1);
    expect(markerAfter(at, "ArrowRight", BOUNDS).dayOfWeek).toBe(3);
    expect(markerAfter({ ...at, dayOfWeek: 1 }, "ArrowLeft", BOUNDS)).toEqual({ ...at, dayOfWeek: 1 });
    expect(markerAfter({ ...at, dayOfWeek: 5 }, "ArrowRight", BOUNDS)).toEqual({ ...at, dayOfWeek: 5 });
  });

  it("stays inside the hours the grid draws, so that it never leaves the screen", () => {
    const top = { dayOfWeek: 1, startMinutes: 480, endMinutes: 540 };
    expect(markerAfter(top, "ArrowUp", BOUNDS)).toEqual(top);
    const bottom = { dayOfWeek: 1, startMinutes: 900, endMinutes: 960 };
    expect(markerAfter(bottom, "ArrowDown", BOUNDS)).toEqual(bottom);
    // Nearer the edge than a step: it goes to the edge.
    expect(markerAfter({ dayOfWeek: 1, startMinutes: 890, endMinutes: 950 }, "ArrowDown", BOUNDS).startMinutes).toBe(900);
    expect(sameSquare(markerAfter(top, "ArrowUp", BOUNDS), top)).toBe(true);
  });
});

describe("the length", () => {
  const hour = lesson("a", 1, 540);

  it("changes by five minutes at the end and keeps the start", () => {
    expect(lengthened(hour, 5, BOUNDS)).toEqual({ dayOfWeek: 1, startMinutes: 540, endMinutes: 605 });
    expect(lengthened(hour, -5, BOUNDS)).toEqual({ dayOfWeek: 1, startMinutes: 540, endMinutes: 595 });
  });

  it("is never shorter than fifteen minutes and never past the end of the day", () => {
    expect(lengthened(lesson("a", 1, 540, 555), -5, BOUNDS)).toBeNull();
    expect(lengthened(lesson("a", 1, 540, 560), -5, BOUNDS)).toEqual({ dayOfWeek: 1, startMinutes: 540, endMinutes: 555 });
    expect(lengthened(lesson("a", 1, 900, 960), 5, BOUNDS)).toBeNull();
  });
});
