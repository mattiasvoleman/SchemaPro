import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BoardFilters, BoardKept, CardNames } from "@/lib/placement-board";
import { GhostColumn, ghostLessonsOf } from "./ghost-layer";

/*
 * The latest schedule behind the week ("Visa senaste schemat"): which of the school's machine-made lessons are drawn for what is picked and
 * the week shown, and how a day's column draws them.
 */

const names: CardNames = {
  subject: (id) => ({ "s-ma": { name: "Matematik", color: "#2563eb" }, "s-sv": { name: "Svenska", color: "#16a34a" } })[id],
  group: (id) => ({ "g-7a": "7A", "g-7b": "7B", "g-8a": "8A" })[id],
  teacher: (id) => (id === "anna" ? "A. Ek" : id === "bo" ? "B. Ceder" : undefined),
  room: (id) => (id === "r-a12" ? "A12" : undefined),
  noRoom: "Motorn väljer sal",
  weeks: () => null,
  color: (_id, color) => color ?? "#999999",
  keptNote: "i grundschemat",
};

const lesson = (id: string, over: Partial<BoardKept> = {}): BoardKept => ({
  id,
  dayOfWeek: 2,
  startTime: "09:00",
  endTime: "10:00",
  studentGroupId: "g-7a",
  extraGroupIds: [],
  subjectId: "s-ma",
  teacherId: "anna",
  coTeacherId: null,
  roomId: "r-a12",
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  locked: false,
  generated: true,
  ...over,
});

const said = (text: string) => `Senaste schemat: ${text}`;
const NONE: BoardFilters = { groups: [], teachers: [], rooms: [] };
const ghostsOf = (lessons: BoardKept[], filters: BoardFilters = { ...NONE, groups: ["g-7a"] }, week: string | null = null) =>
  ghostLessonsOf({ lessons, filters, week, names, said });

describe("ghostLessonsOf", () => {
  it("draws nothing when no class, teacher or room is picked: a school's whole machine-made schedule is no week to read", () => {
    expect(ghostsOf([lesson("a")], NONE)).toEqual([]);
  });

  it("is the lessons the filters pick, as the lessons Generera keeps are: a class and the classes a lesson also has, a teacher or medlärare, a room", () => {
    const lessons = [
      lesson("own"),
      lesson("also", { studentGroupId: "g-8a", extraGroupIds: ["g-7a"] }),
      lesson("other", { studentGroupId: "g-7b" }),
    ];
    expect(ghostsOf(lessons).map((ghost) => ghost.id)).toEqual(["latest:own", "latest:also"]);
    expect(ghostsOf(lessons, { ...NONE, teachers: ["bo"] })).toEqual([]);
    expect(ghostsOf([lesson("co", { teacherId: null, coTeacherId: "bo" })], { ...NONE, teachers: ["bo"] })).toHaveLength(1);
    expect(ghostsOf([lesson("room", { roomId: "r-b3" })], { ...NONE, rooms: ["r-a12"] })).toEqual([]);
    expect(ghostsOf([lesson("room")], { ...NONE, rooms: ["r-a12"] })).toHaveLength(1);
  });

  it("is said for a screen reader: the lesson, its class and teacher, its room and its time", () => {
    expect(ghostsOf([lesson("a")])[0]).toMatchObject({
      id: "latest:a",
      dayOfWeek: 2,
      startMinutes: 540,
      endMinutes: 600,
      title: "Matematik",
      subtitle: "7A · A. Ek",
      color: "#2563eb",
      label: "Senaste schemat: Matematik, 7A · A. Ek, A12, 09:00–10:00",
    });
  });

  it("names the classes a lesson also has, and leaves out what it has no name for", () => {
    const [ghost] = ghostsOf([lesson("a", { extraGroupIds: ["g-7b"], teacherId: null, roomId: null })]);
    expect(ghost!.subtitle).toBe("7A + 7B");
    expect(ghost!.label).toBe("Senaste schemat: Matematik, 7A + 7B, 09:00–10:00");
  });

  describe("one week picked", () => {
    // 2026-08-24 is a Monday of an odd ISO week (35); 2026-08-31 is the next, even one.
    const odd = lesson("odd", { recurrence: "ODD_WEEKS" });
    const even = lesson("even", { recurrence: "EVEN_WEEKS" });
    const every = lesson("every");

    it("keeps what runs that week and no other", () => {
      expect(ghostsOf([odd, even, every], undefined, "2026-08-24").map((ghost) => ghost.id)).toEqual(["latest:odd", "latest:every"]);
      expect(ghostsOf([odd, even, every], undefined, "2026-08-31").map((ghost) => ghost.id)).toEqual(["latest:even", "latest:every"]);
      expect(ghostsOf([odd, even, every], undefined, null)).toHaveLength(3);
    });

    it("asks the lesson's own day of that week: a window that ended on the Monday does not hold the Tuesday", () => {
      const ended = lesson("ended", { startDate: "2026-08-01", endDate: "2026-08-24" });
      expect(ghostsOf([ended], undefined, "2026-08-24")).toEqual([]);
      expect(ghostsOf([lesson("monday", { dayOfWeek: 1, startDate: "2026-08-01", endDate: "2026-08-24" })], undefined, "2026-08-24")).toHaveLength(1);
    });
  });

  it("leaves out a lesson wholly outside the week's day, 08:00 to 18:00, which has no place to be drawn, and keeps one that crosses an edge", () => {
    const lessons = [
      lesson("early", { startTime: "07:00", endTime: "08:00" }),
      lesson("late", { startTime: "18:00", endTime: "19:00" }),
      lesson("over-the-start", { startTime: "07:30", endTime: "08:30" }),
      lesson("over-the-end", { startTime: "17:30", endTime: "18:30" }),
    ];
    expect(ghostsOf(lessons).map((ghost) => ghost.id)).toEqual(["latest:over-the-start", "latest:over-the-end"]);
  });
});

describe("GhostColumn", () => {
  const ghosts = ghostsOf([
    lesson("a", { startTime: "09:00", endTime: "10:00" }),
    lesson("b", { startTime: "09:30", endTime: "10:30", subjectId: "s-sv", teacherId: "bo" }),
    lesson("c", { dayOfWeek: 3, startTime: "11:00", endTime: "12:00" }),
  ]);
  const scale = { startMinutes: 480, pxPerMinute: 1.1 };

  it("draws one day's lessons and no other day's, each as a picture a screen reader says", () => {
    render(<GhostColumn ghosts={ghosts} day={2} scale={scale} />);
    const drawn = screen.getAllByRole("img");
    expect(drawn.map((element) => element.getAttribute("aria-label"))).toEqual([
      "Senaste schemat: Matematik, 7A · A. Ek, A12, 09:00–10:00",
      "Senaste schemat: Svenska, 7A · B. Ceder, A12, 09:30–10:30",
    ]);
  });

  it("puts them where their time is: from the column's first minute, at the height of a minute", () => {
    render(<GhostColumn ghosts={ghosts} day={3} scale={scale} />);
    const [one] = screen.getAllByTestId("placement-ghost");
    // 11:00 is 180 minutes after 08:00: 198 px, and an hour is 66 px.
    expect(one!.style.top).toBe("198px");
    expect(one!.style.height).toBe("66px");
  });

  it("lays lessons that overlap side by side among themselves, and not in the cards' lanes", () => {
    render(<GhostColumn ghosts={ghosts} day={2} scale={scale} />);
    const [first, second] = screen.getAllByTestId("placement-ghost");
    expect(first!.style.left).toBe("calc(0% + 2px)");
    expect(first!.style.width).toBe("calc(50% - 4px)");
    expect(second!.style.left).toBe("calc(50% + 2px)");
  });

  it("is inert: it takes no pointer, as a band does not, or it would take the column's empty slots with it", () => {
    render(<GhostColumn ghosts={ghosts} day={2} scale={scale} />);
    for (const element of screen.getAllByTestId("placement-ghost")) expect(element.className).toContain("pointer-events-none");
  });

  it("is cut at the column's edges: a lesson that crosses 08:00 or 18:00 must not stand outside the day's body (review of #347)", () => {
    render(<GhostColumn ghosts={ghosts} day={2} scale={scale} />);
    const [one] = screen.getAllByTestId("placement-ghost");
    // The grid's scroll box scrolls upright too (overflow-x: auto), so a lesson that reached past the bottom would give it a vertical scroll.
    expect(one!.parentElement).toHaveClass("overflow-hidden", "absolute", "inset-0", "pointer-events-none");
    expect(screen.getByTestId("placement-ghost-column")).toBe(one!.parentElement);
  });

  it("draws nothing for a day that has none", () => {
    render(<GhostColumn ghosts={ghosts} day={5} scale={scale} />);
    expect(screen.queryByTestId("placement-ghost")).not.toBeInTheDocument();
  });
});
