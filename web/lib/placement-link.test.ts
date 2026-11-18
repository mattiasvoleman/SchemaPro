import { describe, expect, it } from "vitest";
import { linkTargetOf, markedRowOf, placementLinkOfRefusal, placementLinkOf } from "./placement-link";
import { keysOfRows } from "./placement-rows";

const query = (href: string) => Object.fromEntries(new URL(href, "http://x").searchParams);
const path = (href: string) => new URL(href, "http://x").pathname;

describe("placementLinkOf", () => {
  it("is the week of the year with no post: no query when the läsår is the active one", () => {
    expect(placementLinkOf({})).toBe("/admin/placements");
    expect(placementLinkOf({ yearId: null })).toBe("/admin/placements");
  });

  it("names the läsår only when it is given (the caller leaves it out for the active one)", () => {
    expect(query(placementLinkOf({ yearId: "y2" }))).toEqual({ year: "y2" });
  });

  it("names the post, the weekday and the clock time of the card", () => {
    const href = placementLinkOf({ yearId: "y2", postId: "post-1", day: 3, start: "10:15" });
    expect(path(href)).toBe("/admin/placements");
    expect(query(href)).toEqual({ year: "y2", post: "post-1", day: "3", start: "10:15" });
  });

  it("names the block as well for a block's lesson, after the day and the start", () => {
    const href = placementLinkOf({ postId: "member", blockId: "block-1", day: 1, start: "08:00" });
    expect(query(href)).toEqual({ post: "member", day: "1", start: "08:00", block: "block-1" });
    expect(Object.keys(query(href))).toEqual(["post", "day", "start", "block"]);
  });

  it("writes the contract's order: year, post, day, start", () => {
    expect(Object.keys(query(placementLinkOf({ yearId: "y", postId: "p", day: 2, start: "09:00" })))).toEqual(["year", "post", "day", "start"]);
  });

  it("leaves a day or a start that is no place on the week out, and keeps the post (the list opens on it)", () => {
    for (const [day, start] of [
      [6, "10:00"],
      [0, "10:00"],
      ["x", "10:00"],
      [3, "25:00"],
      [3, "10:60"],
      [3, "9:00"],
      [3, null],
      [null, "10:00"],
    ] as const) {
      expect(query(placementLinkOf({ postId: "p", day, start })), `${day} ${start}`).toEqual({ post: "p" });
    }
  });

  it("names the block only with the day and the start it is a lesson of: a block with a day that is no place on the week is the post alone", () => {
    expect(query(placementLinkOf({ postId: "p", blockId: "b", day: 6, start: "10:00" }))).toEqual({ post: "p" });
    expect(query(placementLinkOf({ postId: "p", blockId: "b", day: 2, start: null }))).toEqual({ post: "p" });
  });

  it("never names a block without a post", () => {
    expect(placementLinkOf({ blockId: "b", day: 3, start: "10:00" })).toBe("/admin/placements");
  });

  it("encodes what it is given, so an id can never end the query", () => {
    const href = placementLinkOf({ postId: "a&b=c", day: 1, start: "08:00" });
    expect(query(href)["post"]).toBe("a&b=c");
    expect(Object.keys(query(href))).toEqual(["post", "day", "start"]);
  });
});

describe("linkTargetOf", () => {
  it("reads what placementLinkOf wrote", () => {
    expect(linkTargetOf(placementLinkOf({ yearId: "y", postId: "p", day: 4, start: "13:00" }).replace("/admin/placements", ""))).toEqual({
      yearId: "y",
      postId: "p",
      blockId: null,
      day: 4,
      start: "13:00",
    });
    expect(linkTargetOf(placementLinkOf({ postId: "m", blockId: "b", day: 2, start: "08:30" }).replace("/admin/placements", ""))).toEqual({
      yearId: null,
      postId: "m",
      blockId: "b",
      day: 2,
      start: "08:30",
    });
  });

  it("is nothing for an address that names no card: no post, no day or no start", () => {
    expect(linkTargetOf("")).toBeNull();
    expect(linkTargetOf("?year=y")).toBeNull();
    expect(linkTargetOf("?post=p")).toBeNull();
    expect(linkTargetOf("?post=p&day=3")).toBeNull();
    expect(linkTargetOf("?post=p&start=10:00")).toBeNull();
    expect(linkTargetOf("?day=3&start=10:00")).toBeNull();
    expect(linkTargetOf("?post=&day=3&start=10:00")).toBeNull();
  });

  it("is nothing for a value that is not a whole weekday 1 to 5 or a clock time HH:MM", () => {
    for (const bad of ["0", "6", "7", "03", "3.0", "3x", "-1", " 3", "", "NaN"]) {
      expect(linkTargetOf(`?post=p&day=${encodeURIComponent(bad)}&start=10:00`), `day ${bad}`).toBeNull();
    }
    for (const bad of ["24:00", "10:60", "1000", "10:0", "10-00", "ab:cd", "10:00:00", "", " 10:00"]) {
      expect(linkTargetOf(`?post=p&day=3&start=${encodeURIComponent(bad)}`), `start ${bad}`).toBeNull();
    }
  });

  it("accepts every weekday of the school week and the edges of the clock", () => {
    for (const day of [1, 2, 3, 4, 5]) expect(linkTargetOf(`?post=p&day=${day}&start=00:00`)?.day).toBe(day);
    expect(linkTargetOf("?post=p&day=5&start=23:59")?.start).toBe("23:59");
  });

  it("carries the läsår it names, and none when the address names none (the active one)", () => {
    expect(linkTargetOf("?year=y9&post=p&day=2&start=08:30")?.yearId).toBe("y9");
    expect(linkTargetOf("?post=p&day=2&start=08:30")?.yearId).toBeNull();
    expect(linkTargetOf("?year=&post=p&day=2&start=08:30")?.yearId).toBeNull();
  });

  it("carries the block, which the week's own card does not read", () => {
    expect(linkTargetOf("?post=m&day=2&start=08:30&block=b")?.blockId).toBe("b");
    expect(linkTargetOf("?post=m&day=2&start=08:30&block=")?.blockId).toBeNull();
  });
});

describe("markedRowOf", () => {
  const row = (over: Partial<{ id: string; requirementId: string; dayOfWeek: number; startTime: string; teacherId: string | null; minutes: number }> = {}) => ({
    id: "r",
    requirementId: "post-1",
    dayOfWeek: 3,
    startTime: "10:00",
    teacherId: null as string | null,
    minutes: 60,
    recurrence: "ALL_WEEKS" as const,
    ...over,
  });
  const target = { yearId: null, postId: "post-1", blockId: null, day: 3, start: "10:00" };

  it("finds the row on the post, the day and the start", () => {
    const rows = [row({ id: "a", dayOfWeek: 2 }), row({ id: "b" }), row({ id: "c", startTime: "11:00" }), row({ id: "d", requirementId: "post-2" })];
    expect(markedRowOf(rows, target)?.id).toBe("b");
  });

  it("matches a start that carries seconds, as the gateway's TIME columns may", () => {
    expect(markedRowOf([row({ id: "s", startTime: "10:00:00" })], target)?.id).toBe("s");
  });

  it("is nothing when no row is there: the lesson was moved or removed since the run", () => {
    expect(markedRowOf([row({ dayOfWeek: 4 })], target)).toBeUndefined();
    expect(markedRowOf([row({ startTime: "10:05" })], target)).toBeUndefined();
    expect(markedRowOf([row({ requirementId: "other" })], target)).toBeUndefined();
    expect(markedRowOf([], target)).toBeUndefined();
  });

  it("does not take a row by its teacher: a row of another teacher on a shared post is the post's lesson all the same", () => {
    expect(markedRowOf([row({ id: "bo", teacherId: "bo" })], target)?.id).toBe("bo");
  });

  it("takes the one the judge says no to of two alike: a refusal about one half of a pair is about that half, and the address cannot tell the halves apart", () => {
    type VerdictRow = ReturnType<typeof row> & { verdict: { ok: boolean } };
    const withVerdict = (over: Parameters<typeof row>[0], ok: boolean): VerdictRow => ({ ...row(over), verdict: { ok } });
    const halves = [withVerdict({ id: "odd", recurrence: "ODD_WEEKS" } as never, true), withVerdict({ id: "even", recurrence: "EVEN_WEEKS" } as never, false)];
    expect(markedRowOf(halves, target)?.id).toBe("even");
    // Both holding, or both failing: the first, as before; and rows with no verdict (a board read by an older reader) the first too.
    expect(markedRowOf([withVerdict({ id: "a" }, true), withVerdict({ id: "b" }, true)], target)?.id).toBe("a");
    expect(markedRowOf([withVerdict({ id: "a" }, false), withVerdict({ id: "b" }, false)], target)?.id).toBe("a");
    expect(markedRowOf([row({ id: "a" }), row({ id: "b" })], target)?.id).toBe("a");
  });

  it("takes the first of two alike, which is the card without a number (#2 is the second)", () => {
    const rows = [row({ id: "first" }), row({ id: "second" })];
    const keys = keysOfRows(rows);
    expect(keys[0]!.endsWith("#2")).toBe(false);
    expect(keys[1]!.endsWith("#2")).toBe(true);
    expect(markedRowOf(rows, target)?.id).toBe("first");
  });
});

describe("placementLinkOfRefusal", () => {
  const line = { postId: "post-1", day: 3, start: "10:00" };

  it("builds the link from the ids and the place the gateway says", () => {
    expect(query(placementLinkOfRefusal(line, "y2")!)).toEqual({ year: "y2", post: "post-1", day: "3", start: "10:00" });
    expect(query(placementLinkOfRefusal({ ...line, blockId: "b" }, null)!)).toEqual({ post: "post-1", day: "3", start: "10:00", block: "b" });
  });

  it("is no link for a refusal stored before the ids, or one that names no post", () => {
    expect(placementLinkOfRefusal({ day: 3, start: "10:00" }, null)).toBeNull();
    expect(placementLinkOfRefusal({ postId: "", day: 3, start: "10:00" }, null)).toBeNull();
    expect(placementLinkOfRefusal({ postId: 7, day: 3, start: "10:00" }, null)).toBeNull();
    expect(placementLinkOfRefusal(null, null)).toBeNull();
    expect(placementLinkOfRefusal(undefined, null)).toBeNull();
  });

  it("is a link to the post only when the day or the start is no place on the week (a refusal about a Saturday)", () => {
    expect(query(placementLinkOfRefusal({ postId: "p", day: 6, start: "10:00" }, null)!)).toEqual({ post: "p" });
    expect(query(placementLinkOfRefusal({ postId: "p", day: 3 }, null)!)).toEqual({ post: "p" });
  });
});
