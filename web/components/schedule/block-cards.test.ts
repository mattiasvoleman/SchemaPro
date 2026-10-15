import { describe, expect, it } from "vitest";
import type { MasterLesson, TeachingRequirement } from "@/lib/types";
import { cardsOf } from "./block-cards";

/**
 * Which lessons are one card (Block i schemat). Språkval åk 7 holds Tyska för
 * Ty7 and Franska för Fr7; 7A's Svenska is in no block.
 */

const lesson = (id: string, studentGroupId: string, subjectId: string, overrides: Partial<MasterLesson> = {}) =>
  ({
    id,
    academicYearId: "y",
    subjectId,
    studentGroupId,
    teacherId: null,
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 1,
    startTime: "10:00:00",
    endTime: "11:00:00",
    isLocked: false,
    isParked: false,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
    ...overrides,
  }) as MasterLesson;

const posts = [
  { studentGroupId: "ty7", subjectId: "de", blockId: "b" },
  { studentGroupId: "fr7", subjectId: "fr", blockId: "b" },
  { studentGroupId: "7a", subjectId: "sv", blockId: null },
] as TeachingRequirement[];
const names = new Map([["b", "Språkval åk 7"]]);

describe("cardsOf", () => {
  it("makes one card of the members standing in one slot, keyed by its first lesson", () => {
    const { cards, cardOf, apart } = cardsOf(
      [lesson("a-ty", "ty7", "de"), lesson("b-fr", "fr7", "fr"), lesson("c-sv", "7a", "sv")],
      posts,
      names,
    );

    expect([...cards.values()].map((card) => [card.id, card.name, card.lessons.map((row) => row.id), card.complete])).toEqual([
      ["block:a-ty", "Språkval åk 7", ["a-ty", "b-fr"], true],
    ]);
    expect(cardOf.get("b-fr")?.id).toBe("block:a-ty");
    expect(cardOf.has("c-sv")).toBe(false);
    expect(apart.size).toBe(0);
  });

  it("keeps a member moved away apart, and the card it left incomplete", () => {
    const { cards, apart } = cardsOf(
      [
        lesson("a-ty", "ty7", "de"),
        lesson("b-fr", "fr7", "fr"),
        lesson("c-ty", "ty7", "de", { dayOfWeek: 3 }),
        lesson("d-fr", "fr7", "fr", { dayOfWeek: 4 }),
      ],
      posts,
      names,
    );

    expect([...cards.keys()]).toEqual(["block:a-ty"]);
    expect([...apart.entries()].sort()).toEqual([
      ["c-ty", "Språkval åk 7"],
      ["d-fr", "Språkval åk 7"],
    ]);
  });

  it("reads other weeks at the same clock, and a parked lesson, as no card", () => {
    const { cards } = cardsOf(
      [
        lesson("a-ty", "ty7", "de"),
        lesson("b-fr", "fr7", "fr", { recurrence: "ODD_WEEKS" }),
        lesson("c-ty", "ty7", "de", { dayOfWeek: 2 }),
        lesson("d-fr", "fr7", "fr", { dayOfWeek: 2, isParked: true }),
      ],
      posts,
      names,
    );

    expect(cards.size).toBe(0);
  });

  it("does not count a second lesson of one member as a second member", () => {
    const { cards, apart } = cardsOf(
      [lesson("a-ty", "ty7", "de"), lesson("b-ty", "ty7", "de"), lesson("c-fr", "fr7", "fr")],
      posts,
      names,
    );

    expect([...cards.values()][0]?.lessons.map((row) => row.id)).toEqual(["a-ty", "c-fr"]);
    expect([...apart.keys()]).toEqual(["b-ty"]);
  });

  it("marks nothing apart in a block only one member has placed", () => {
    const { cards, apart } = cardsOf([lesson("a-ty", "ty7", "de")], posts, names);

    expect(cards.size).toBe(0);
    expect(apart.size).toBe(0);
  });
});
