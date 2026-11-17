import { describe, expect, it } from "vitest";
import fixture from "../../src/requirement-placements/__fixtures__/placement-clash-cases.json";
import { blockClashes, dropOf, insideSchoolDay, moverOfBlockBrick, moverOfBlockRow, type Mover, type OtherNames } from "./placement-drop";
import { blockKeyByRowId } from "./placement-block-rows";
import type { BoardBlock, BoardKept, BoardMeal, BoardPlacement, BoardPost, PlacementBoard } from "./placement-board";
import { buildMirror } from "./placement-mirror";
import { keyByRowId } from "./placement-rows";
import { clockOfMinutes, minutesOfClock } from "./requirement-placement-text";
import type { AvailabilityConstraint, StudentGroup } from "./types";

/**
 * THE MIRROR MUST NOT BE MILDER THAN THE JUDGE (planens risk 7).
 *
 * src/requirement-placements/__fixtures__/placement-clash-cases.json holds small worlds, one candidate row each, and
 * the verdict of the gateway's REAL judge (placement-judge.ts judgePlacements, run against a real database by
 * scripts/test/probe-forlagg-spegel.ts and written back with FORLAGG_SPEGEL_WRITE=1). The ghost under a drag is the
 * grundschema's mirror of the clash rule over the week's facts (placement-mirror.ts); this runs the same worlds
 * through it. For the rules it has (TEACHER, ROOM, GROUP, AVAILABILITY, FRAME, LUNCH, GRADE_RULE, SCHOOL_DAY) it
 * refuses where the judge refuses, with the same reason; it may be stricter only where a case says so
 * (`mirrorStricter`), and milder only where the judge's rule is one the week's facts do not carry (`outsideMirror`).
 *
 * THE BLOCKS (C2). A parallel block's lessons are in the worlds (`blocks`, posts that are `block` members and are taught to a teaching
 * `group`), and the candidate is one of two kinds: an ordinary post's row against a world with blocks (the PUT on the post's path),
 * or a lesson of a block (the PUT on the block's path, the candidate first). The judge reads a block's lesson once per member and holds the
 * members against each other; so does the mirror (placement-drop.ts blockClashes). For a refused block lesson the verdict names the member
 * (`post`) the judge refuses first, and the mirror must refuse that member too, with the same reason; it may refuse more.
 */

interface World {
  classes: { key: string; grade: number }[];
  teachers: string[];
  rooms: string[];
  subjects: string[];
  pupils: { key: string; class: string }[];
  groups: { key: string; members: string[] }[];
  posts: { key: string; class?: string; group?: string; subject: string; teacher: string; coTeacher?: string; minutes: number; lessons: number; recurrence?: string; startDate?: string; endDate?: string; minutesBefore?: number; minutesAfter?: number; shares?: { teacher: string; lessons: number }[]; lengths?: number[]; block?: string }[];
  blocks?: { key: string; posts: string[]; lessons: { day: number; start: string; minutes: number; rooms?: Record<string, string> }[] }[];
  kept: { class?: string; group?: string; subject: string; teacher: string; coTeacher?: string; room?: string; day: number; start: string; minutes: number; recurrence?: string; startDate?: string; endDate?: string; extraClasses?: string[]; locked?: boolean }[];
  rows: { post: string; day: number; start: string; minutes: number; room?: string; recurrence?: string; teacher?: string }[];
  unavailable: { kind: "teacher" | "room" | "class" | "grade"; key?: string; grades?: [number, number]; day: number; start: string; end: string }[];
  frames: { grades: [number, number]; start: string; end: string }[];
  meals: { class: string; day: number; start: string; end: string; generated?: boolean }[];
}

interface Case {
  name: string;
  rule: string;
  outsideMirror?: boolean;
  mirrorStricter?: boolean;
  add: Partial<World>;
  candidate: PostCandidate | BlockCandidate;
  verdict: { ok: boolean; reason?: string; post?: string };
}
type PostCandidate = { post: string; block?: undefined; day: number; start: string; minutes: number; room?: string; recurrence?: string; teacher?: string; replaces?: number };
type BlockCandidate = { block: string; post?: undefined; day: number; start: string; minutes: number; rooms?: Record<string, string>; replaces?: number };
const isBlockCandidate = (candidate: Case["candidate"]): candidate is BlockCandidate => candidate.block !== undefined;

const base = fixture.base as unknown as World;
const cases = fixture.cases as unknown as Case[];

/** The base world with the case's additions: posts of the same key are replaced, everything else is added. */
function worldOf(add: Partial<World>): World {
  const world: World = structuredClone(base);
  for (const key of Object.keys(add) as (keyof World)[]) {
    if (key === "posts") {
      for (const post of add.posts!) world.posts = [...world.posts.filter((entry) => entry.key !== post.key), post];
    } else if (key === "blocks") {
      // A block of the same key REPLACES the base's (the readme).
      for (const block of add.blocks!) world.blocks = [...(world.blocks ?? []).filter((entry) => entry.key !== block.key), block];
    } else {
      (world[key] as unknown[]) = [...(world[key] as unknown[]), ...(add[key] as unknown[])];
    }
  }
  return world;
}

const endOf = (start: string, minutes: number): string => clockOfMinutes(minutesOfClock(start) + minutes);

function boardOf(world: World): PlacementBoard {
  const posts: BoardPost[] = world.posts.map((post) => ({
    id: post.key,
    studentGroupId: (post.class ?? post.group)!,
    subjectId: post.subject,
    teacherId: post.teacher,
    coTeacherId: post.coTeacher ?? null,
    recurrence: (post.recurrence ?? "ALL_WEEKS") as BoardPost["recurrence"],
    startDate: post.startDate ?? null,
    endDate: post.endDate ?? null,
    minutesBefore: post.minutesBefore ?? 0,
    minutesAfter: post.minutesAfter ?? 0,
    cannotPlace: post.block ? "BLOCK" : null,
    parts: [
      { teacherId: post.teacher, minutes: post.minutes, count: post.lessons, locked: 0, placed: 0, left: post.lessons, cannotPlace: null },
      ...(post.shares ?? []).map((share) => ({ teacherId: share.teacher, minutes: post.minutes, count: share.lessons, locked: 0, placed: 0, left: share.lessons, cannotPlace: null })),
    ],
    rowsKey: "e3b0c44298fc1c14",
  }));
  const postOf = new Map(posts.map((post) => [post.id, post]));
  const placements: BoardPlacement[] = world.rows.map((row, index) => {
    const post = postOf.get(row.post)!;
    return {
      id: `r${index}`,
      requirementId: row.post,
      dayOfWeek: row.day,
      startTime: row.start,
      endTime: endOf(row.start, row.minutes),
      minutes: row.minutes,
      roomId: row.room ?? null,
      roomName: row.room ?? null,
      recurrence: (row.recurrence ?? post.recurrence) as BoardPlacement["recurrence"],
      teacherId: row.teacher ?? null,
      changedAt: "2026-11-13T08:00:00.000Z",
      verdict: { ok: true },
    };
  });
  const kept: BoardKept[] = world.kept.map((lesson, index) => ({
    id: `k${index}`,
    dayOfWeek: lesson.day,
    startTime: lesson.start,
    endTime: endOf(lesson.start, lesson.minutes),
    studentGroupId: (lesson.class ?? lesson.group)!,
    extraGroupIds: lesson.extraClasses ?? [],
    subjectId: lesson.subject,
    teacherId: lesson.teacher,
    coTeacherId: lesson.coTeacher ?? null,
    roomId: lesson.room ?? null,
    recurrence: (lesson.recurrence ?? "ALL_WEEKS") as BoardKept["recurrence"],
    startDate: lesson.startDate ?? null,
    endDate: lesson.endDate ?? null,
    locked: lesson.locked ?? true,
    generated: false,
  }));
  // The board carries the meals the school placed by hand only (the judge holds a row to no other): a lunch Generera laid is not in it.
  const meals: BoardMeal[] = world.meals.filter((meal) => meal.generated !== true).map((meal, index) => ({
    id: `m${index}`,
    studentGroupId: meal.class,
    dayOfWeek: meal.day,
    startTime: meal.start,
    endTime: meal.end,
    startDate: null,
    endDate: null,
  }));
  const blocks: BoardBlock[] = (world.blocks ?? []).map((block) => {
    const members = block.posts.map((key) => world.posts.find((entry) => entry.key === key)!);
    const first = members[0]!;
    return {
      id: block.key,
      name: block.key,
      memberIds: block.posts,
      lengths: first.lengths ?? Array.from({ length: first.lessons }, () => first.minutes),
      recurrence: (first.recurrence ?? "ALL_WEEKS") as BoardBlock["recurrence"],
      followsBlockId: null,
      cannotPlace: null,
      rows: block.lessons.map((lesson, index) => ({
        id: `${block.key}-${index}`,
        dayOfWeek: lesson.day,
        startTime: lesson.start,
        endTime: endOf(lesson.start, lesson.minutes),
        minutes: lesson.minutes,
        recurrence: (first.recurrence ?? "ALL_WEEKS") as BoardPlacement["recurrence"],
        rooms: Object.entries(lesson.rooms ?? {}).map(([requirementId, roomId]) => ({ requirementId, roomId, roomName: roomId })),
        changedAt: "2026-11-13T08:00:00.000Z",
        verdicts: [],
      })),
      rowsKey: "k",
    };
  });
  return { academicYearId: "y1", posts, placements, kept, meals, blocks };
}

function constraintsOf(world: World): AvailabilityConstraint[] {
  return world.unavailable.map((entry, index) => ({
    id: `c${index}`,
    resourceType: entry.kind === "teacher" ? "TEACHER" : entry.kind === "room" ? "ROOM" : entry.kind === "class" ? "STUDENT_GROUP" : "GRADE_LEVEL",
    userId: entry.kind === "teacher" ? entry.key! : null,
    roomId: entry.kind === "room" ? entry.key! : null,
    studentGroupId: entry.kind === "class" ? entry.key! : null,
    minGradeLevel: entry.kind === "grade" ? entry.grades![0] : null,
    maxGradeLevel: entry.kind === "grade" ? entry.grades![1] : null,
    dayOfWeek: entry.day,
    date: null,
    startTime: entry.start,
    endTime: entry.end,
    type: "UNAVAILABLE",
    reason: null,
  }));
}

const names: OtherNames = { group: (id) => id, subject: (id) => id };

/** What the mirror says of the case's candidate. */
function mirrorSays(testCase: Case) {
  const world = worldOf(testCase.add);
  const board = boardOf(world);
  const groups: StudentGroup[] = [
    ...world.classes.map((entry) => ({ id: entry.key, academicYearId: "y1", name: entry.key, kind: "CLASS" as const, gradeLevel: entry.grade })),
    ...world.groups.map((entry) => ({ id: entry.key, academicYearId: "y1", name: entry.key, kind: "TEACHING_GROUP" as const, gradeLevel: null })),
  ];
  const keys = keyByRowId(board.placements);
  const mirror = buildMirror({
    board,
    keys,
    groups,
    studentGroupOf: new Map(world.pupils.map((pupil) => [pupil.key, pupil.class])),
    memberships: world.groups.flatMap((entry) => entry.members.map((studentId) => ({ studentId, studentGroupId: entry.key }))),
    constraints: constraintsOf(world),
    frames: world.frames.map((frame, index) => ({ id: `f${index}`, minGradeLevel: frame.grades[0], maxGradeLevel: frame.grades[1], dayOfWeek: null, startTime: frame.start, endTime: frame.end })),
    academicYearId: "y1",
  });
  const candidate = testCase.candidate;
  const start = minutesOfClock(candidate.start);
  const span = { dayOfWeek: candidate.day, startMinutes: start, endMinutes: start + candidate.minutes };
  if (isBlockCandidate(candidate)) {
    // A lesson of a block: the block's posts sit it, each with the room it was given; a move is the stored lesson, which is out of its own way.
    const block = board.blocks.find((entry) => entry.id === candidate.block)!;
    const postsById = new Map(board.posts.map((entry) => [entry.id, entry]));
    const rooms = new Map<string, string | null>(Object.entries(candidate.rooms ?? {}));
    const replacedLesson = candidate.replaces === undefined ? undefined : block.rows[candidate.replaces];
    const blockKeys = blockKeyByRowId(board.blocks);
    const mover = replacedLesson
      ? moverOfBlockRow(`blockplacement:${blockKeys.get(replacedLesson.id)}`, blockKeys.get(replacedLesson.id)!, block, replacedLesson, postsById, rooms)
      : moverOfBlockBrick("block:candidate", block, postsById, rooms);
    if (!insideSchoolDay(span)) return { said: "DAY", members: new Map<string, string>() };
    const clashes = blockClashes(mirror, mover, span, names);
    return { said: clashes[0]?.reason ?? null, members: new Map(clashes.map((clash) => [clash.requirementId!, clash.reason as string])) };
  }
  const post = board.posts.find((entry) => entry.id === candidate.post)!;
  const replaced = candidate.replaces === undefined ? undefined : board.placements[candidate.replaces];
  const mover: Mover = {
    // A move: the row it replaces is the same lesson, so it is not in its own way (the card's id, as the page names it).
    id: replaced ? `placement:${keys.get(replaced.id)}` : "candidate",
    post,
    teacherId: candidate.teacher ?? post.teacherId,
    roomId: candidate.room ?? null,
    recurrence: (candidate.recurrence ?? post.recurrence) as Mover["recurrence"],
  };
  const drop = dropOf(mirror, mover, span, names);
  return { said: drop.kind === "OK" ? null : drop.kind === "CLASH" ? (drop.reason as string) : drop.kind, members: new Map<string, string>() };
}

/**
 * The judge's reason as the mirror says it: a year rule is one more constraint to the mirror, the school day is its own kind,
 * and pupils a teaching group shares with the class (PUPILS) are one more clash of groups (GROUP) to the mirror: both refuse.
 */
const MIRROR_REASON: Record<string, string> = { GRADE_RULE: "AVAILABILITY", SCHOOL_DAY: "DAY", PUPILS: "GROUP" };

describe("the cases", () => {
  it("cover every rule the mirror has, each with a case that refuses and a case that holds", () => {
    const rules = ["TEACHER", "ROOM", "GROUP", "AVAILABILITY", "FRAME", "LUNCH", "GRADE_RULE", "SCHOOL_DAY"];
    for (const rule of rules) {
      const own = cases.filter((entry) => entry.rule === rule);
      expect(own.filter((entry) => !entry.verdict.ok).length, `${rule} refused`).toBeGreaterThan(0);
      expect(own.filter((entry) => entry.verdict.ok).length, `${rule} held`).toBeGreaterThan(0);
      // A teaching group that shares pupils with the class is a clash of groups to the mirror and PUPILS to the judge.
      for (const entry of own.filter((candidate) => !candidate.verdict.ok)) expect([rule, ...(rule === "GROUP" ? ["PUPILS"] : [])]).toContain(entry.verdict.reason);
    }
  });

  it("hold the pupils' minutes around an idrott against the class's other lessons: the candidate's own, a kept lesson's, a förläggning's and a second class's (review of #326, MEDEL-3)", () => {
    const withBuffer = cases.filter((entry) => (entry.add.posts ?? []).some((post) => (post.minutesBefore ?? 0) > 0 || (post.minutesAfter ?? 0) > 0));
    expect(withBuffer.length).toBeGreaterThanOrEqual(8);
    // Each refuses with GROUP, and a case beside it where the minutes are exactly spent holds.
    expect(withBuffer.filter((entry) => !entry.verdict.ok && entry.verdict.reason === "GROUP").length).toBeGreaterThanOrEqual(5);
    expect(withBuffer.filter((entry) => entry.verdict.ok).length).toBeGreaterThanOrEqual(3);
  });

  it("have a name each and a verdict the judge gave (no case is left on a guess)", () => {
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
    for (const entry of cases) {
      expect(typeof entry.verdict.ok).toBe("boolean");
      if (!entry.verdict.ok) expect(typeof entry.verdict.reason).toBe("string");
    }
  });
});

describe("the mirror against the judge", () => {
  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, testCase) => {
    const { said, members } = mirrorSays(testCase);
    if (testCase.verdict.ok) {
      // The mirror may be stricter than the judge, but only where the case says it is.
      if (testCase.mirrorStricter) expect(said, "the case says the mirror is stricter").not.toBeNull();
      else expect(said, `the judge holds it, the mirror says ${said}`).toBeNull();
      return;
    }
    if (testCase.outsideMirror) {
      // A rule the week's facts do not carry: the gateway answers at the drop. Pinned, so that a mirror that learns it is noticed.
      expect(said, "the case is outside the mirror").toBeNull();
      return;
    }
    const reason = MIRROR_REASON[testCase.verdict.reason!] ?? testCase.verdict.reason;
    if (isBlockCandidate(testCase.candidate) && testCase.verdict.post !== undefined && said !== "DAY") {
      // A lesson of a block: the member the judge refuses first is refused by the mirror too, for the same reason (it may refuse more).
      expect([...members.keys()], `the judge refuses ${testCase.verdict.post} with ${testCase.verdict.reason}, the mirror refuses ${JSON.stringify([...members])}`).toContain(testCase.verdict.post);
      expect(members.get(testCase.verdict.post), `the member the judge refuses, ${testCase.verdict.post}`).toBe(reason);
      return;
    }
    // Never milder: where the judge refuses, the mirror refuses, and for the same reason.
    expect(said, `the judge refuses with ${testCase.verdict.reason}, the mirror holds it`).toBe(reason);
  });
});

describe("the cases of the blocks", () => {
  const ofBlocks = cases.filter((entry) => isBlockCandidate(entry.candidate) || (entry.add.blocks ?? []).length > 0);

  it("are at least twenty, of both kinds: a post's row against a block's lessons, and a lesson of a block", () => {
    expect(ofBlocks.length).toBeGreaterThanOrEqual(20);
    expect(ofBlocks.filter((entry) => !isBlockCandidate(entry.candidate)).length).toBeGreaterThanOrEqual(8);
    expect(ofBlocks.filter((entry) => isBlockCandidate(entry.candidate)).length).toBeGreaterThanOrEqual(12);
  });

  it("have a refusing case and a holding case for TEACHER, ROOM and GROUP of both kinds", () => {
    for (const kind of ["post", "block"] as const) {
      for (const rule of ["TEACHER", "ROOM", "GROUP"]) {
        const own = ofBlocks.filter((entry) => (kind === "block") === isBlockCandidate(entry.candidate) && entry.rule === rule);
        expect(own.filter((entry) => !entry.verdict.ok).length, `${kind} ${rule} refused`).toBeGreaterThan(0);
        expect(own.filter((entry) => entry.verdict.ok).length, `${kind} ${rule} held`).toBeGreaterThan(0);
      }
    }
  });

  it("name the member the judge refuses for every refused lesson of a block (except the school day, which is the lesson's)", () => {
    for (const entry of ofBlocks.filter((candidate) => isBlockCandidate(candidate.candidate) && !candidate.verdict.ok && candidate.verdict.reason !== "SCHOOL_DAY")) {
      expect(typeof entry.verdict.post, entry.name).toBe("string");
    }
  });

  it("hold a move that only shifts the lesson a quarter of an hour (the lesson is not in its own way) and a stored lesson that no longer holds", () => {
    const moves = ofBlocks.filter((entry) => isBlockCandidate(entry.candidate) && entry.candidate.replaces !== undefined);
    expect(moves.length).toBeGreaterThanOrEqual(3);
    expect(moves.filter((entry) => entry.verdict.ok).length).toBeGreaterThanOrEqual(2);
  });
});
