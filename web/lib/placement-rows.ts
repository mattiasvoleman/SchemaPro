import type { BoardPart, BoardPlacement, BoardPost, PlacementBoard } from "@/lib/placement-board";
import type { PlacementInput, PlacementRecurrence } from "@/lib/requirement-placements";
import { clockOfMinutes } from "@/lib/requirement-placement-text";

/*
 * Förlägg i veckan, the part of writing that is arithmetic on lists: what a
 * lesson on the week is CALLED, how a post's whole list is rebuilt with one row
 * moved, added or removed, and what is still to lay (the bricks).
 *
 * A LESSON ON THE WEEK IS NOT ITS ROW. Every save of a post replaces the whole
 * list with new ids (DELETE and INSERT in the gateway), so a card, a selection,
 * a focus and an undo step that held a row's id would point at nothing after the
 * very save that made it. They are named by what the lesson is: the post, the
 * teacher whose lesson it is, its length and its place (day, start and weeks)
 * (planens risk 10). Two rows that are the same on all of these are one lesson
 * twice and interchangeable; they get a number after the name so each is unique
 * inside a list.
 *
 * THE PUT REPLACES THE WHOLE LIST, so a move of one row is a write of every row
 * of the post, and every other row goes back as it is: its room, its teacher and
 * its weeks unchanged. Dropping a shared post's teacherId here would give the
 * whole post NO_TEACHER, which is why the rows are built in one place and
 * tested row by row.
 *
 * Pure: no React, no clock, no network.
 */

/** What names a lesson on the week: its post, its teacher, its length and its place. */
export type PlacementKeyed = Pick<BoardPlacement, "requirementId" | "teacherId" | "minutes" | "dayOfWeek" | "startTime" | "recurrence">;

/** The name of a lesson before it is made unique inside a list. */
export const placementKeyOf = (row: PlacementKeyed): string =>
  [row.requirementId, row.teacherId ?? "", row.minutes, row.dayOfWeek, row.startTime, row.recurrence].join("|");

/**
 * One unique key per row, in the rows' own order: `placementKeyOf`, and `#2`, `#3`
 * after the second and third row that is the same lesson. The same rows in the
 * same order get the same keys, and a save that gives them new ids does not change
 * them.
 */
export function keysOfRows(rows: readonly PlacementKeyed[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = placementKeyOf(row);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key}#${count}`;
  });
}

/** Row id → its key, for the cards of a board's rows. */
export function keyByRowId(rows: readonly (PlacementKeyed & { id: string })[]): Map<string, string> {
  const keys = keysOfRows(rows);
  return new Map(rows.map((row, index) => [row.id, keys[index]!]));
}

/** A lesson of a post that shares its lessons between teachers: its rows each name their teacher. */
export const sharesLessons = (post: Pick<BoardPost, "teacherId" | "parts">): boolean =>
  post.parts.some((part) => part.teacherId !== post.teacherId);

/** A stored row as the PUT takes it, unchanged: its room, its teacher (where the post shares) and its weeks go back as they were. */
export function inputOf(row: Pick<BoardPlacement, "dayOfWeek" | "startTime" | "minutes" | "roomId" | "recurrence" | "teacherId">): PlacementInput {
  return {
    dayOfWeek: row.dayOfWeek,
    startTime: row.startTime,
    minutes: row.minutes,
    roomId: row.roomId,
    recurrence: row.recurrence,
    ...(row.teacherId !== null ? { teacherId: row.teacherId } : {}),
  };
}

/** A spot on the week: a day and a start in minutes since midnight. */
export interface Spot {
  dayOfWeek: number;
  startMinutes: number;
}

export type RowEdit =
  | { kind: "add"; input: PlacementInput }
  /** The two halves of a pair, odd weeks and even weeks, added in one write: the database refuses a lone half (lib/placement-pair.ts). */
  | { kind: "addPair"; inputs: readonly [PlacementInput, PlacementInput] }
  /** A row to another place, and, when `roomId` is given (null: the engine chooses), to another room; left out, its room stays. */
  | { kind: "move"; key: string; to: Spot; roomId?: string | null }
  | { kind: "remove"; keys: readonly string[] };

/**
 * The post's whole list with one change made to it, every other row as it
 * stands; null for a row the list no longer has (the week moved under the
 * reader). `rows` are the post's rows in the board's order.
 */
export function listAfter(rows: readonly BoardPlacement[], edit: RowEdit): PlacementInput[] | null {
  const list = rows.map(inputOf);
  if (edit.kind === "add") return [...list, edit.input];
  if (edit.kind === "addPair") return [...list, ...edit.inputs];
  const keys = keysOfRows(rows);
  const at = (key: string): number => keys.indexOf(key);
  if (edit.kind === "remove") {
    const doomed = new Set(edit.keys.map(at));
    if (doomed.has(-1)) return null;
    return list.filter((_, index) => !doomed.has(index));
  }
  const index = at(edit.key);
  if (index === -1) return null;
  const row = list[index]!;
  return list.map((entry, i) =>
    i !== index
      ? entry
      : {
          ...row,
          dayOfWeek: edit.to.dayOfWeek,
          startTime: clockOfMinutes(edit.to.startMinutes),
          ...(edit.roomId !== undefined ? { roomId: edit.roomId } : {}),
        },
  );
}

/**
 * The rows a removal of this one takes with it. A half of a pair (odd or even
 * weeks of an every-week post) goes with the other half, because the database
 * refuses a lone half (PAIRS): the first row of the other parity with the same
 * teacher and length. Any other row goes alone.
 */
export function removalOf(rows: readonly BoardPlacement[], post: Pick<BoardPost, "recurrence">, key: string): string[] {
  const keys = keysOfRows(rows);
  const index = keys.indexOf(key);
  const row = rows[index];
  if (!row || post.recurrence !== "ALL_WEEKS" || row.recurrence === "ALL_WEEKS") return [key];
  const partner = rows.findIndex(
    (other, i) => i !== index && other.recurrence !== "ALL_WEEKS" && other.recurrence !== row.recurrence && other.teacherId === row.teacherId && other.minutes === row.minutes,
  );
  return partner === -1 ? [key] : [key, keys[partner]!];
}

/** One lesson still to lay: a post's, a teacher's and a length. */
export interface Brick {
  /** `post|teacher|minutes#n`: n counts the post's identical bricks, so each is unique while the post has them. */
  key: string;
  postId: string;
  teacherId: string | null;
  minutes: number;
}

const partKey = (postId: string, part: Pick<BoardPart, "teacherId" | "minutes">): string => `${postId}|${part.teacherId ?? ""}|${part.minutes}`;

/**
 * The lessons left to lay: one brick per lesson, for every part of a post that
 * has any left and can be laid at all (a post in a block is laid with its block,
 * a part nobody teaches waits for a teacher). The same count the page says per
 * post: what Generera would ask the engine for.
 */
export function bricksOf(posts: readonly Pick<BoardPost, "id" | "cannotPlace" | "parts">[]): Brick[] {
  const bricks: Brick[] = [];
  for (const post of posts) {
    if (post.cannotPlace !== null) continue;
    for (const part of post.parts) {
      if (part.cannotPlace !== null) continue;
      for (let n = 1; n <= part.left; n++) {
        bricks.push({ key: `${partKey(post.id, part)}#${n}`, postId: post.id, teacherId: part.teacherId, minutes: part.minutes });
      }
    }
  }
  return bricks;
}

/** The row a brick becomes at a spot: the post's weeks, the lesson's teacher where the post shares, the room given (or none: the engine chooses). */
export function inputOfBrick(brick: Brick, post: Pick<BoardPost, "recurrence" | "teacherId" | "parts">, spot: Spot, roomId: string | null): PlacementInput {
  return {
    dayOfWeek: spot.dayOfWeek,
    startTime: clockOfMinutes(spot.startMinutes),
    minutes: brick.minutes,
    roomId,
    recurrence: post.recurrence as PlacementRecurrence,
    ...(sharesLessons(post) ? { teacherId: brick.teacherId } : {}),
  };
}

/** The post's rows in the board's order. */
export function rowsOfPost(board: Pick<PlacementBoard, "placements">, postId: string): BoardPlacement[] {
  return board.placements.filter((row) => row.requirementId === postId);
}

/** The key the next write of a post must say it is made on top of: the board's, which a write's answer replaces. */
export const baseKeyOf = (board: Pick<PlacementBoard, "posts">, postId: string): string | undefined =>
  board.posts.find((post) => post.id === postId)?.rowsKey;
