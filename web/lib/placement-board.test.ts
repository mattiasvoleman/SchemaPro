import { describe, expect, it } from "vitest";
import {
  NO_FILTERS,
  dayEndMarkers,
  isFiltered,
  keptCards,
  mealBands,
  placementCards,
  reachOf,
  savedAt,
  summaryOf,
  totalsOf,
  visibleBoard,
  weekDay,
  type BoardKept,
  type BoardMeal,
  type BoardPlacement,
  type BoardPost,
  type CardNames,
  type PlacementBoard,
} from "./placement-board";

/**
 * What the page draws is the gateway's to count and to judge (the board's own
 * specs): here only what this file does with the answer — the sums, the filters
 * and the cards — is held, with the two traps of it: a row belongs to its
 * LESSON's teacher (the post's own on a post that shares nothing), and a card
 * for a förläggning that no longer holds must say so without colour alone.
 */

const part = (over: Partial<BoardPost["parts"][number]> = {}): BoardPost["parts"][number] => ({
  teacherId: "anna",
  minutes: 60,
  count: 2,
  locked: 0,
  placed: 0,
  left: 2,
  cannotPlace: null,
  ...over,
});

const post = (over: Partial<BoardPost> = {}): BoardPost => ({
  id: "post-1",
  studentGroupId: "g-7a",
  subjectId: "s-ma",
  teacherId: "anna",
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  cannotPlace: null,
  parts: [part()],
  ...over,
});

const row = (over: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id: "row-1",
  requirementId: "post-1",
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
  ...over,
});

const kept = (over: Partial<BoardKept> = {}): BoardKept => ({
  id: "k-1",
  dayOfWeek: 3,
  startTime: "13:00",
  endTime: "14:00",
  studentGroupId: "g-7a",
  extraGroupIds: [],
  subjectId: "s-ma",
  teacherId: "anna",
  coTeacherId: null,
  roomId: "r-a12",
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  locked: true,
  generated: false,
  ...over,
});

const meal = (over: Partial<BoardMeal> = {}): BoardMeal => ({
  id: "m-1",
  studentGroupId: "g-7a",
  dayOfWeek: 2,
  startTime: "11:00",
  endTime: "11:30",
  startDate: null,
  endDate: null,
  ...over,
});

const board = (over: Partial<PlacementBoard> = {}): PlacementBoard => ({
  academicYearId: "y1",
  placements: [],
  posts: [],
  kept: [],
  meals: [],
  ...over,
});

const names: CardNames = {
  subject: (id) => (id === "s-ma" ? { name: "Matematik", color: "#2563eb" } : undefined),
  group: (id) => ({ "g-7a": "7A", "g-7b": "7B" })[id],
  teacher: (id) => ({ anna: "A. Ek", bo: "B. Lind" })[id ?? ""],
  room: (id) => ({ "r-a12": "A12" })[id ?? ""],
  weeks: (lesson) => (lesson.recurrence === "ODD_WEEKS" ? "udda" : null),
  color: (_subject, color) => color ?? "#999999",
  keptNote: "i grundschemat",
};

describe("the figures", () => {
  it("sums a post over its parts", () => {
    const shared = post({
      parts: [part({ count: 2, locked: 1, placed: 1, left: 0 }), part({ teacherId: "bo", count: 1, locked: 0, placed: 0, left: 1 })],
    });
    expect(totalsOf(shared)).toEqual({ count: 3, locked: 1, placed: 1, left: 1 });
  });

  it("counts the year's rows, those that do not hold, and the lessons still to lay", () => {
    const year = board({
      posts: [post({ parts: [part({ placed: 1, left: 1 })] }), post({ id: "post-2", parts: [part({ left: 3, count: 3 })] })],
      placements: [row(), row({ id: "row-2", verdict: { ok: false, reason: "TEACHER" } })],
    });
    expect(summaryOf(year)).toEqual({ rows: 2, failing: 1, placed: 1, left: 4 });
  });
});

describe("visibleBoard", () => {
  const year = board({
    posts: [
      post(),
      post({ id: "post-2", studentGroupId: "g-7b", teacherId: "bo", parts: [part({ teacherId: "bo" })] }),
      post({ id: "post-3", studentGroupId: "g-7b", teacherId: "anna", parts: [part({ teacherId: "anna" }), part({ teacherId: "bo", count: 1, left: 1 })] }),
    ],
    placements: [
      row({ id: "a" }),
      row({ id: "b", requirementId: "post-2", roomId: "r-b3", roomName: "B3" }),
      // A shared post's row names its own teacher: Bo's lesson on a post whose huvudlärare is Anna.
      row({ id: "c", requirementId: "post-3", teacherId: "bo" }),
    ],
    kept: [kept(), kept({ id: "k-2", studentGroupId: "g-7b", extraGroupIds: ["g-7a"], teacherId: "bo", coTeacherId: "anna", roomId: null })],
    meals: [meal(), meal({ id: "m-2", studentGroupId: "g-7b" })],
  });

  it("shows everything with no filter, and draws no meal (a band for every class is a wall)", () => {
    const all = visibleBoard(year, NO_FILTERS);
    expect(all.posts).toHaveLength(3);
    expect(all.placements).toHaveLength(3);
    expect(all.kept).toHaveLength(2);
    expect(all.meals).toEqual([]);
    expect(isFiltered(NO_FILTERS)).toBe(false);
  });

  it("narrows by class: the posts, the rows, the lessons it also has, and its meals", () => {
    const shown = visibleBoard(year, { ...NO_FILTERS, groups: ["g-7a"] });
    expect(shown.posts.map((entry) => entry.id)).toEqual(["post-1"]);
    expect(shown.placements.map((entry) => entry.id)).toEqual(["a"]);
    // 7B's lesson that is also 7A's belongs to 7A's week.
    expect(shown.kept.map((entry) => entry.id)).toEqual(["k-1", "k-2"]);
    expect(shown.meals.map((entry) => entry.id)).toEqual(["m-1"]);
  });

  it("narrows by the lesson's teacher, so a shared post's row is its own teacher's and not the huvudlärare's", () => {
    const bo = visibleBoard(year, { ...NO_FILTERS, teachers: ["bo"] });
    expect(bo.placements.map((entry) => entry.id)).toEqual(["b", "c"]);
    expect(bo.posts.map((entry) => entry.id)).toEqual(["post-2", "post-3"]);
    // The medlärare is in the room too.
    expect(bo.kept.map((entry) => entry.id)).toEqual(["k-2"]);
    const anna = visibleBoard(year, { ...NO_FILTERS, teachers: ["anna"] });
    expect(anna.placements.map((entry) => entry.id)).toEqual(["a"]);
    expect(anna.kept.map((entry) => entry.id)).toEqual(["k-1", "k-2"]);
  });

  it("narrows by room: the rows in it, the posts that have one there, and the lessons kept in it", () => {
    const shown = visibleBoard(year, { ...NO_FILTERS, rooms: ["r-b3"] });
    expect(shown.placements.map((entry) => entry.id)).toEqual(["b"]);
    expect(shown.posts.map((entry) => entry.id)).toEqual(["post-2"]);
    expect(shown.kept).toEqual([]);
    expect(isFiltered({ ...NO_FILTERS, rooms: ["r-b3"] })).toBe(true);
  });
});

describe("the cards", () => {
  it("draws a förläggning with its subject, class and teacher, in its room, with its weeks", () => {
    const [card] = placementCards([row({ recurrence: "ODD_WEEKS" })], new Map([["post-1", post()]]), names);
    expect(card).toMatchObject({
      id: "placement:row-1",
      dayOfWeek: 2,
      startMinutes: 600,
      endMinutes: 660,
      title: "Matematik",
      subtitle: "7A · A. Ek",
      room: "A12",
      color: "#2563eb",
      conflicted: false,
      recurrenceNote: "udda",
    });
    expect(card).not.toHaveProperty("locked");
  });

  it("takes a shared post's row to its own teacher, and marks one that no longer holds", () => {
    const shared = post({ parts: [part(), part({ teacherId: "bo", count: 1 })] });
    const [card] = placementCards([row({ teacherId: "bo", verdict: { ok: false, reason: "ROOM" } })], new Map([["post-1", shared]]), names);
    expect(card!.subtitle).toBe("7A · B. Lind");
    expect(card!.conflicted).toBe(true);
  });

  it("draws a kept lesson with a padlock, the classes it has and the note that it stands in the grundschema", () => {
    const [card] = keptCards([kept({ extraGroupIds: ["g-7b"], recurrence: "ODD_WEEKS" })], names);
    expect(card).toMatchObject({
      id: "kept:k-1",
      title: "Matematik",
      subtitle: "7A + 7B · A. Ek",
      locked: true,
      recurrenceNote: "i grundschemat · udda",
    });
  });

  it("draws a meal as a hand-placed band", () => {
    expect(mealBands([meal()], (entry) => `Måltid ${entry.studentGroupId}`)).toEqual([
      { id: "meal:m-1", dayOfWeek: 2, startMinutes: 660, endMinutes: 690, label: "Måltid g-7a", handPlaced: true },
    ]);
  });
});

describe("the end of the day", () => {
  it("is drawn as a strip on each weekday when nothing else reaches past 17:00", () => {
    const strips = dayEndMarkers(reachOf([{ endMinutes: 15 * 60 }]), { title: "Skoldagen", line: "slutar 18:00" });
    expect(strips.map((strip) => strip.dayOfWeek)).toEqual([1, 2, 3, 4, 5]);
    expect(strips[0]).toMatchObject({ startMinutes: 17 * 60 + 45, endMinutes: 18 * 60, duty: true, relieved: true, title: "Skoldagen", subtitle: "slutar 18:00" });
  });

  it("is not drawn when a lesson already reaches the last hour, and the empty grid has it too", () => {
    expect(dayEndMarkers(reachOf([{ endMinutes: 17 * 60 + 30 }]), { title: "a", line: "b" })).toEqual([]);
    expect(dayEndMarkers(reachOf([]), { title: "a", line: "b" })).toHaveLength(5);
  });
});

describe("the dates", () => {
  it("writes an instant in the school's zone and the reader's language", () => {
    // 08:00 UTC on 13 November is 09:00 in Stockholm.
    expect(savedAt("2026-11-13T08:00:00.000Z", "sv")).toMatch(/13 nov.*09:00/);
    expect(savedAt("2026-11-13T08:00:00.000Z", "en")).toMatch(/13 Nov.*09:00/);
  });

  it("writes a day as it was written, whatever zone the browser is in", () => {
    expect(weekDay("2026-08-24", "sv")).toMatch(/24 aug.*2026/);
    expect(weekDay("2026-08-24", "en")).toMatch(/24 Aug.*2026/);
  });
});
