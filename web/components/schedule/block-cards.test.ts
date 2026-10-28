import { describe, expect, it } from "vitest";
import type { MasterLesson, TeachingRequirement } from "@/lib/types";
import { cardsOf, moveBackOf } from "./block-cards";

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

  it("names a block whose name is not read with the fallback, and keeps each block's placed lessons", () => {
    const { cards, byBlock } = cardsOf(
      [lesson("a-ty", "ty7", "de"), lesson("b-fr", "fr7", "fr"), lesson("c-ty", "ty7", "de", { dayOfWeek: 3 }), lesson("d-fr", "fr7", "fr", { isParked: true })],
      posts,
      new Map(),
      "Parallellt block",
    );

    expect([...cards.values()][0]?.name).toBe("Parallellt block");
    expect(byBlock.get("b")?.map((row) => row.id).sort()).toEqual(["a-ty", "b-fr", "c-ty"]);
  });

  it("marks nothing apart in a block only one member has placed", () => {
    const { cards, apart } = cardsOf([lesson("a-ty", "ty7", "de")], posts, names);

    expect(cards.size).toBe(0);
    expect(apart.size).toBe(0);
  });
});

describe("cardsOf, a post alone in its block on another's times", () => {
  // Dela i halvklass with hemkunskap: 6A:1 reads it in the first period
  // (block HT), 6A:2 in the second (block VT, on HT's times), one post each.
  const halves = [
    { studentGroupId: "6a1", subjectId: "hkk", blockId: "ht" },
    { studentGroupId: "6a2", subjectId: "hkk", blockId: "vt" },
  ] as TeachingRequirement[];
  const halfNames = new Map([
    ["ht", "Hemkunskap 6A HT"],
    ["vt", "Hemkunskap 6A VT"],
  ]);
  const pair = new Map([
    ["ht", "vt"],
    ["vt", "ht"],
  ]);

  it("makes each of its lessons a whole card of one", () => {
    const { cards, cardOf, apart } = cardsOf(
      [
        lesson("a1", "6a1", "hkk"),
        lesson("a2", "6a1", "hkk", { dayOfWeek: 3 }),
        lesson("b1", "6a2", "hkk", { startDate: "2027-01-08" }),
      ],
      halves,
      halfNames,
      "",
      pair,
    );

    expect(
      [...cards.values()].map((card) => [card.id, card.name, card.lessons.map((row) => row.id), card.complete]).sort(),
    ).toEqual([
      ["block:a1", "Hemkunskap 6A HT", ["a1"], true],
      ["block:a2", "Hemkunskap 6A HT", ["a2"], true],
      ["block:b1", "Hemkunskap 6A VT", ["b1"], true],
    ]);
    expect(cardOf.get("b1")?.id).toBe("block:b1");
    expect(apart.size).toBe(0);
  });

  it("leaves a lone post's lessons as lessons when its block is on nobody's times", () => {
    const { cards, apart } = cardsOf([lesson("a1", "6a1", "hkk")], halves, halfNames);

    expect(cards.size).toBe(0);
    expect(apart.size).toBe(0);
  });

  it("still needs two members in a slot of a block of two posts on another's times", () => {
    const { cards, apart } = cardsOf(
      [lesson("a-ty", "ty7", "de"), lesson("b-fr", "fr7", "fr", { dayOfWeek: 3 })],
      posts,
      names,
      "",
      new Map([
        ["b", "x"],
        ["x", "b"],
      ]),
    );

    expect(cards.size).toBe(0);
    expect([...apart.keys()].sort()).toEqual(["a-ty", "b-fr"]);
  });
});

describe("moveBackOf", () => {
  const from = { lessonIds: ["ty", "fr"], dayOfWeek: 1, startTime: "10:00", endTime: "11:00" };

  it("takes back exactly the other term's card the move took, and none when it took none", () => {
    expect(moveBackOf(from, { propagatedLessons: 0, joined: [], followed: ["vt1", "vt2"] })).toEqual({
      ...from,
      follow: ["vt1", "vt2"],
    });
    // The spring card stood where the autumn card landed: the undo leaves it there.
    expect(moveBackOf(from, { propagatedLessons: 0, joined: [], followed: [] })).toEqual({ ...from, follow: [] });
  });

  it("leaves behind what the card took in, and sends an older API the body it always got", () => {
    const joined = [{ id: "sp", isGenerated: false }];
    expect(moveBackOf(from, { propagatedLessons: 0, joined })).toEqual({ ...from, leave: joined });
    expect(moveBackOf(from, { propagatedLessons: 0 })).toEqual(from);
  });
});
