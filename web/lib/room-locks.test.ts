import { describe, expect, it } from "vitest";
import { allowedRooms, breaksRoomLock } from "@/lib/room-locks";
import type { RoomPreference } from "@/lib/queries";

const rule = (
  id: string,
  rooms: string[],
  {
    kind = "LOCK" as RoomPreference["kind"],
    subjectId = "matte",
    min = null as number | null,
    max = null as number | null,
  } = {},
): RoomPreference => ({
  id,
  subjectId,
  kind,
  minGradeLevel: min,
  maxGradeLevel: max,
  roomTypeId: null,
  weight: 5,
  rooms: rooms.map((roomId) => ({ roomId })),
});

const span = (min: number, max: number) => ({ min, max });
const ids = (set: Set<string> | null) => (set === null ? null : [...set].sort());

describe("allowedRooms", () => {
  it("is null when no lock reaches the lesson", () => {
    // Null and an empty set mean opposite things: nothing said, versus a rule
    // that now names nothing.
    expect(allowedRooms([], "matte", span(4, 4))).toBeNull();
  });

  it("ignores a wish, which is a price and not a bound", () => {
    const rules = [rule("w", ["a"], { kind: "WISH" })];
    expect(allowedRooms(rules, "matte", span(4, 4))).toBeNull();
  });

  it("ignores a lock for another subject", () => {
    const rules = [rule("l", ["a"], { subjectId: "engelska" })];
    expect(allowedRooms(rules, "matte", span(4, 4))).toBeNull();
  });

  it("applies a lock with no span to every year", () => {
    // What every rule written before the column existed means.
    expect(ids(allowedRooms([rule("l", ["a"])], "matte", span(9, 9)))).toEqual(["a"]);
  });

  it("does not reach a group only half inside the span", () => {
    /*
     * Containment, and the case that separates it from overlap: a 6-7 group
     * overlaps an åk 7-9 rule at year 7, and applying it would send the group's
     * year-6 pupils to a högstadie room.
     */
    const rules = [rule("l", ["a"], { min: 7, max: 9 })];
    expect(allowedRooms(rules, "matte", span(6, 7))).toBeNull();
  });

  it("does not reach a group whose years are unknown", () => {
    const rules = [rule("l", ["a"], { min: 7, max: 9 })];
    expect(allowedRooms(rules, "matte", undefined)).toBeNull();
  });

  it("lets the narrowest rule win rather than emptying the set", () => {
    /*
     * "Matte åk 4-6 → Bryggan" plus "matte åk 4 → Optimisten" intersects to
     * nothing, and a whole subject × stage becomes impossible from two
     * sentences a school would reasonably write. Under specificity the second
     * is an exception to the first.
     */
    const rules = [
      rule("broad", ["bryggan"], { min: 4, max: 6 }),
      rule("narrow", ["optimisten"], { min: 4, max: 4 }),
    ];
    expect(ids(allowedRooms(rules, "matte", span(4, 4)))).toEqual(["optimisten"]);
    expect(ids(allowedRooms(rules, "matte", span(5, 5)))).toEqual(["bryggan"]);
  });

  it("makes a rule with no span lose every tie to one that has a span", () => {
    // Otherwise a school's one general rule overrides every exception it wrote.
    const rules = [
      rule("general", ["bryggan"]),
      rule("narrow", ["optimisten"], { min: 4, max: 4 }),
    ];
    expect(ids(allowedRooms(rules, "matte", span(4, 4)))).toEqual(["optimisten"]);
  });

  it("unions rules of equal width, so a duplicate is harmless", () => {
    const rules = [
      rule("one", ["optimisten"], { min: 4, max: 4 }),
      rule("two", ["bryggan"], { min: 4, max: 4 }),
    ];
    expect(ids(allowedRooms(rules, "matte", span(4, 4)))).toEqual([
      "bryggan",
      "optimisten",
    ]);
  });
});

describe("breaksRoomLock", () => {
  const lock = [rule("l", ["optimisten"], { min: 4, max: 4 })];

  it("says nothing about a lesson with no room yet", () => {
    // Reporting it would flag every lesson a school has not finished placing.
    expect(breaksRoomLock(lock, "matte", span(4, 4), null)).toBe(false);
  });

  it("leaves a lesson in an allowed room alone", () => {
    expect(breaksRoomLock(lock, "matte", span(4, 4), "optimisten")).toBe(false);
  });

  it("flags a lesson in a room the lock forbids", () => {
    expect(breaksRoomLock(lock, "matte", span(4, 4), "bryggan")).toBe(true);
  });

  it("says nothing when no lock reaches the lesson", () => {
    expect(breaksRoomLock(lock, "matte", span(9, 9), "bryggan")).toBe(false);
  });

  it("says nothing about a lock that now names no rooms at all", () => {
    /*
     * Every room it named has been deleted. The RULE is broken, not the lesson,
     * and saying so on every lesson of the subject would bury the one message
     * that matters. The API refuses to delete a lock's last room; this is the
     * belt to that pair of braces.
     */
    const emptied = [rule("l", [], { min: 4, max: 4 })];
    expect(breaksRoomLock(emptied, "matte", span(4, 4), "bryggan")).toBe(false);
  });
});
