import { describe, expect, it } from "vitest";
import {
  formatReleaseDay,
  idsToRelease,
  idsToTakeBack,
  releaseLines,
  releasedIn,
  staffedIn,
  type ReleaseGroup,
  type ReleasePost,
} from "./engine-release";

/**
 * The page's side of "släppt för motorn": the posts of a school grouped by subject and årskurs, and the ids a press
 * sends. The gateway knows no subject, so "release the whole subject in åk 7" is exactly this expansion.
 */

const groups: ReleaseGroup[] = [
  { id: "g-7a", name: "7A", gradeLevel: 7 },
  { id: "g-7b", name: "7B", gradeLevel: 7 },
  { id: "g-8a", name: "8A", gradeLevel: 8 },
  { id: "g-fk", name: "Förskoleklassen", gradeLevel: 0 },
  { id: "g-sv", name: "Svenska 2", gradeLevel: null },
];
const subjects: Record<string, string> = { "s-ma": "Matematik", "s-en": "Engelska", "s-sv": "Svenska" };

const post = (id: string, subjectId: string, studentGroupId: string, teacherId: string | null): ReleasePost => ({
  id,
  subjectId,
  studentGroupId,
  teacherId,
});

const posts: ReleasePost[] = [
  post("p-ma-7b", "s-ma", "g-7b", "t-bo"),
  post("p-ma-7a", "s-ma", "g-7a", "t-bo"),
  post("p-ma-8a", "s-ma", "g-8a", "t-anna"),
  post("p-ma-sv", "s-ma", "g-sv", "t-anna"),
  post("p-ma-fk", "s-ma", "g-fk", null),
  post("p-en-7a", "s-en", "g-7a", "t-anna"),
  post("p-ma-gone", "s-ma", "g-8a", "t-gone"),
  post("p-ma-nogroup", "s-ma", "g-missing", "t-bo"),
];

const lines = (released: string[] = []) =>
  releaseLines({
    posts,
    groups,
    subjectName: (id) => subjects[id] ?? "—",
    activeStaff: (userId) => userId !== "t-gone",
    released: new Set(released),
  });
const line = (key: string, released: string[] = []) => lines(released).find((candidate) => candidate.key === key)!;

describe("releaseLines", () => {
  it("groups the posts by subject, then årskurs ascending with förskoleklass first and 'utan årskurs' last", () => {
    expect(lines().map((row) => [row.subjectName, row.gradeLevel, row.posts.length])).toEqual([
      ["Engelska", 7, 1],
      ["Matematik", 0, 1],
      ["Matematik", 7, 2],
      ["Matematik", 8, 2],
      // A group without a årskurs, and a post whose group the list does not hold, share the line.
      ["Matematik", null, 2],
    ]);
  });

  it("puts a line's posts in group order, a group the list does not hold first as a dash", () => {
    expect(line("s-ma|7").posts.map((row) => row.groupName)).toEqual(["7A", "7B"]);
    expect(line("s-ma|none").posts.map((row) => row.groupName)).toEqual(["—", "Svenska 2"]);
  });

  it("calls a post staffed only while an active teacher leads it", () => {
    const eight = line("s-ma|8").posts;
    expect(eight.map((row) => [row.id, row.staffed])).toEqual([
      ["p-ma-8a", true],
      // The teacher has left: always open to the engine, as a post nobody teaches is.
      ["p-ma-gone", false],
    ]);
    expect(line("s-ma|0").posts[0]).toMatchObject({ teacherId: null, staffed: false });
  });

  it("marks the posts the gateway lists as released, staffed or not", () => {
    const row = line("s-ma|8", ["p-ma-gone", "p-ma-7a"]);
    expect(row.posts.map((post) => [post.id, post.released])).toEqual([
      ["p-ma-8a", false],
      ["p-ma-gone", true],
    ]);
    expect(releasedIn(row)).toBe(1);
    expect(staffedIn(row)).toBe(1);
  });
});

describe("what a press sends", () => {
  it("releases only the line's staffed posts that are not released yet", () => {
    expect(idsToRelease(line("s-ma|7"))).toEqual(["p-ma-7a", "p-ma-7b"]);
    // One is released already: nothing to say about it, and N is what the press changes.
    expect(idsToRelease(line("s-ma|7", ["p-ma-7a"]))).toEqual(["p-ma-7b"]);
    // A post nobody teaches, or whose teacher has left, needs no release.
    expect(idsToRelease(line("s-ma|0"))).toEqual([]);
    expect(idsToRelease(line("s-ma|8"))).toEqual(["p-ma-8a"]);
  });

  it("takes back every post of the line, released or not", () => {
    expect(idsToTakeBack(line("s-ma|7", ["p-ma-7a"]))).toEqual(["p-ma-7a", "p-ma-7b"]);
    expect(idsToTakeBack(line("s-ma|8"))).toEqual(["p-ma-8a", "p-ma-gone"]);
  });
});

describe("formatReleaseDay", () => {
  it("writes the day in the school's own time zone, the same in every language", () => {
    // 23:30 UTC on the 19th is the 20th in Stockholm.
    expect(formatReleaseDay("2026-11-19T23:30:00.000Z", "Europe/Stockholm")).toBe("2026-11-20");
    expect(formatReleaseDay("2026-11-19T23:30:00.000Z", "UTC")).toBe("2026-11-19");
  });
});
