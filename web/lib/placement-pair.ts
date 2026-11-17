import type { TimetableLesson } from "@/components/schedule/timetable-grid";
import type { Placement, PupilBufferMap } from "@/lib/conflicts";
import { pupilBufferOf } from "@/lib/conflicts";
import type { BoardPost } from "@/lib/placement-board";
import { clockOfMinutes } from "@/lib/requirement-placement-text";
import { inputOfBrick, type Brick, type Spot } from "@/lib/placement-rows";
import { otherParity } from "@/lib/placement-weeks";
import type { PlacementInput } from "@/lib/requirement-placements";

/*
 * Förlägg i veckan, a pair (D2): one lesson of an every-week post laid in TWO places, odd weeks here and even weeks there.
 *
 * THE DATABASE REFUSES A LONE HALF (PAIRS: an odd row and an even row of a length must come in equal numbers, and
 * TEACHER_PAIRS says the same per teacher on a shared post), and it refuses a half that names no room (PAIR_ROOM: a pair is sent
 * to the engine as two locks, and a lock has a room). So the first half cannot be written when it is laid: it is HELD, in the
 * browser, until the second is laid, and then both go in one write, the post's whole list with two rows added. The held half is
 * the one state of the week that exists nowhere but in the page, and these functions are the whole of what is decided about it.
 *
 * WHAT BECOMES OF A HELD HALF (planens risk, "den osparade halvan"). Nothing is stored: not in the database, not in localStorage.
 *
 *   - Leaving the page. Closing or reloading asks (the browser's own question); a link inside the app asks; the browser's Back
 *     button does not ask and the half is gone. The half is two or three clicks and nobody else could have seen it.
 *   - Another läsår is chosen. The half is released and the page says so: it belongs to a post of the year that is left.
 *   - Undo. The half is the newest thing done and is taken back FIRST, before any written step: Ctrl+Z on a held half releases
 *     it and writes nothing. Redo never brings a half back (a half is not a step).
 *   - A 409 (STALE) on the write of the pair. Nothing is written, the week is read again and the FIRST half stays held; the
 *     second is the one that is laid again. If the week as read has no lesson left to lay for the part, the half is released.
 *   - Another refusal (a clash, no room). Nothing is written; the half stays and the sentence says what to change.
 *   - The week is read again (a filter, a write of somebody else's). The half stays while the part still has a lesson to lay,
 *     which is decided on the WHOLE board, not on what the filters show: a half is not lost to a filter.
 *   - Another brick is chosen or pulled while a half is held: not allowed (the page says to lay or release the half first), so
 *     that there is never a half of one lesson and a brick of another in play at once.
 *
 * Pure: no React, no clock, no network.
 */

/** The weeks of one half of a pair. */
export type Half = "ODD_WEEKS" | "EVEN_WEEKS";

/**
 * The first half of a pair, laid and not yet written. It belongs to a PART of a post (the post, the teacher whose lesson it is on
 * a post that shares, and the length), not to a brick's key, because a brick is named by a count (`#n`) that moves.
 */
export interface HeldHalf {
  /** `post|teacher|minutes`: the part's name (a brick's key without its count). */
  partKey: string;
  postId: string;
  /** The teacher whose lesson it is; null on a post that shares nothing. */
  teacherId: string | null;
  minutes: number;
  /** The weeks this half runs. The other half runs the other weeks. */
  recurrence: Half;
  dayOfWeek: number;
  startMinutes: number;
  /** A half names its room: a pair is sent as two locks. */
  roomId: string;
}

/** The part a brick belongs to: its key without the count that tells the post's identical bricks apart. */
export const partKeyOfBrick = (brick: Pick<Brick, "key">): string => brick.key.replace(/#\d+$/, "");

/** Whether a post's lesson can be a pair: the post runs every week (an odd post or an even one has no other half). */
export const canBePair = (post: Pick<BoardPost, "recurrence" | "cannotPlace">): boolean => post.recurrence === "ALL_WEEKS" && post.cannotPlace === null;

/** The card of a held half, named by its part: `pairhalf:<post|teacher|minutes>`. */
export const heldHalfCardId = (partKey: string): string => `pairhalf:${partKey}`;

/** The weeks the lesson being laid runs: the held half's other weeks once there is one, else the weeks the reader chose to start with. */
export const weeksBeingLaid = (held: HeldHalf | null, first: Half): Half => (held ? otherParity(held.recurrence) : first);

/** The two rows of a pair, as the PUT takes them: the held half and the one just laid, each with its weeks, its room and (on a shared post) its teacher. */
export function pairInputs(
  brick: Brick,
  post: Pick<BoardPost, "recurrence" | "teacherId" | "parts">,
  held: HeldHalf,
  second: { spot: Spot; roomId: string },
): [PlacementInput, PlacementInput] {
  const row = (recurrence: Half, spot: Spot, roomId: string): PlacementInput => ({ ...inputOfBrick(brick, post, spot, roomId), recurrence });
  return [
    row(held.recurrence, { dayOfWeek: held.dayOfWeek, startMinutes: held.startMinutes }, held.roomId),
    row(otherParity(held.recurrence), second.spot, second.roomId),
  ];
}

/** The words a held half's card is written from. */
export interface HeldHalfNames {
  subject: string;
  /** "7A · A. Ek". */
  subtitle: string;
  room: string | undefined;
  color: string;
  /** "udda · inte sparad". */
  note: string;
}

/**
 * The held half as a card on the week: dashed (`relieved`, the grid's own mark for something that is not in force) and saying, in
 * its note, that it is not saved. It is a card the reader can move (it is still only in the page), so it has a lesson's id and span.
 */
export function heldHalfCard(held: HeldHalf, names: HeldHalfNames): TimetableLesson {
  return {
    id: heldHalfCardId(held.partKey),
    dayOfWeek: held.dayOfWeek,
    startMinutes: held.startMinutes,
    endMinutes: held.startMinutes + held.minutes,
    title: names.subject,
    subtitle: names.subtitle,
    ...(names.room ? { room: names.room } : {}),
    color: names.color,
    relieved: true,
    recurrenceNote: names.note,
  };
}

/**
 * The held half as the clash rule reads a lesson, so that a lesson laid beside it is held against it (a half that is in nobody's
 * way would be laid over by the next brick, and the gateway would refuse the pair at the end for it).
 */
export function heldHalfPlacement(held: HeldHalf, post: Pick<BoardPost, "studentGroupId" | "subjectId" | "coTeacherId" | "teacherId" | "startDate" | "endDate">, buffers?: PupilBufferMap): Placement {
  return {
    ...(pupilBufferOf(buffers, post) ?? {}),
    id: heldHalfCardId(held.partKey),
    dayOfWeek: held.dayOfWeek,
    startMinutes: held.startMinutes,
    endMinutes: held.startMinutes + held.minutes,
    teacherId: held.teacherId ?? post.teacherId,
    coTeacherId: post.coTeacherId,
    roomId: held.roomId,
    studentGroupId: post.studentGroupId,
    subjectId: post.subjectId,
    recurrence: held.recurrence,
    startDate: post.startDate,
    endDate: post.endDate,
  };
}

/** What happens to a held half when something happens to the week. */
export type PairEvent =
  /** Another läsår is chosen. */
  | { kind: "year" }
  /** Ctrl+Z, or the Ångra button. */
  | { kind: "undo" }
  /** Redo. */
  | { kind: "redo" }
  /** A write of the pair came back 409 STALE (somebody else wrote the post). */
  | { kind: "stale" }
  /** The write of the pair was refused for the rows' sake (a clash, a missing room): nothing was written. */
  | { kind: "refused" }
  /** The week was read again; `partLeft` is whether the part still has a lesson to lay on the whole board. */
  | { kind: "read"; partLeft: boolean }
  /** The pair was written. */
  | { kind: "written" };

/** What is done with a held half for an event: kept, or released (the page says why in the case of a release the reader did not ask for). */
export function fateOf(event: PairEvent): "keep" | "release" {
  switch (event.kind) {
    case "year":
    case "undo":
    case "written":
      return "release";
    case "read":
      return event.partLeft ? "keep" : "release";
    case "redo":
    case "stale":
    case "refused":
      return "keep";
  }
}

/** The clock text of a half's start, for the sentences. */
export const startOfHalf = (held: Pick<HeldHalf, "startMinutes">): string => clockOfMinutes(held.startMinutes);
