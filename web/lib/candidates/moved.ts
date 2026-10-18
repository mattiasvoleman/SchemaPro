import { clockOf } from "./lessons";

/*
 * Which lessons a candidate moves, against the draft it would replace.
 *
 * Generated lessons have no stable ids — every regeneration deletes them and
 * creates new rows — so a lesson is recognised by what it is, never by its
 * id. The pairing is the gateway's `moved` metric, kept in step on purpose
 * (design §5): a multiset match on (class, subject, day, start, end) between
 * the draft's non-preserved lessons and the candidate's. What matches is
 * kept; a kept slot whose room differs is a room change; the rest moved.
 *
 * A list says more than the count can, so the unmatched lessons are paired up
 * again, within each (class, subject), in weekday and clock order — diffDraft's
 * third pass (src/publication/draft.service.ts) — to be shown as "from → to".
 * That second pairing is a reading aid and not a claim: Ma for 7A on Monday
 * and Wednesday becoming Tuesday and Thursday is two moves either way, and
 * which goes where is the clock's order, not the engine's.
 */

/** Where a lesson sits: its day, its clock, its room. */
export interface Slot {
  dayOfWeek: number;
  /** "HH:MM". */
  startTime: string;
  endTime: string;
  roomId: string | null;
}

/** The fields a lesson is recognised by, on either side. */
export interface SlotLesson extends Slot {
  studentGroupId: string;
  subjectId: string;
}

export type MoveKind =
  /** At another time (and perhaps in another room). */
  | "MOVED"
  /** At the same time, in another room. */
  | "ROOM"
  /** A draft lesson the candidate has no counterpart for: the requirement asks for fewer now. */
  | "REMOVED"
  /** A candidate lesson with no draft counterpart: placed where the draft had none. */
  | "ADDED";

export interface MovedLesson {
  kind: MoveKind;
  studentGroupId: string;
  subjectId: string;
  from: Slot | null;
  to: Slot | null;
}

const slotKey = (lesson: SlotLesson) =>
  `${lesson.studentGroupId}|${lesson.subjectId}|${lesson.dayOfWeek}|${clockOf(lesson.startTime)}|${clockOf(lesson.endTime)}`;

const lineKey = (lesson: SlotLesson) => `${lesson.studentGroupId}|${lesson.subjectId}`;

const byClock = (a: Slot, b: Slot) =>
  a.dayOfWeek - b.dayOfWeek ||
  clockOf(a.startTime).localeCompare(clockOf(b.startTime)) ||
  clockOf(a.endTime).localeCompare(clockOf(b.endTime));

function slotOf(lesson: SlotLesson): Slot {
  return {
    dayOfWeek: lesson.dayOfWeek,
    startTime: clockOf(lesson.startTime),
    endTime: clockOf(lesson.endTime),
    roomId: lesson.roomId,
  };
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(key(item));
    if (list) list.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/**
 * Every difference between the draft's replaceable lessons and a
 * candidate's, in weekday and clock order of where each lesson was (or, for
 * an added one, of where it goes).
 *
 * Within a matched slot, equal rooms pair first: two 7A Ma lessons at the
 * same time in rooms A and B against B and A are no room change at all, and
 * reporting two would invent work for whoever reads the list.
 */
export function movedLessons(
  draft: readonly SlotLesson[],
  candidate: readonly SlotLesson[],
): MovedLesson[] {
  const moves: MovedLesson[] = [];
  const leftDraft: SlotLesson[] = [];
  const leftCandidate: SlotLesson[] = [];

  const candidateBySlot = groupBy(candidate, slotKey);
  const draftBySlot = groupBy(draft, slotKey);
  for (const [key, before] of draftBySlot) {
    const after = [...(candidateBySlot.get(key) ?? [])];
    candidateBySlot.delete(key);
    const unpairedBefore: SlotLesson[] = [];
    for (const lesson of before) {
      const same = after.findIndex((other) => other.roomId === lesson.roomId);
      if (same >= 0) after.splice(same, 1);
      else unpairedBefore.push(lesson);
    }
    // Same slot, rooms left over on both sides: room changes, in order.
    while (unpairedBefore.length > 0 && after.length > 0) {
      const lesson = unpairedBefore.shift()!;
      const other = after.shift()!;
      moves.push({
        kind: "ROOM",
        studentGroupId: lesson.studentGroupId,
        subjectId: lesson.subjectId,
        from: slotOf(lesson),
        to: slotOf(other),
      });
    }
    leftDraft.push(...unpairedBefore);
    leftCandidate.push(...after);
  }
  for (const rest of candidateBySlot.values()) leftCandidate.push(...rest);

  const candidateByLine = groupBy(leftCandidate, lineKey);
  for (const [key, before] of groupBy(leftDraft, lineKey)) {
    const from = before.map(slotOf).sort(byClock);
    const to = (candidateByLine.get(key) ?? []).map(slotOf).sort(byClock);
    candidateByLine.delete(key);
    const [studentGroupId, subjectId] = [before[0]!.studentGroupId, before[0]!.subjectId];
    from.forEach((slot, index) => {
      const target = to[index];
      moves.push({ kind: target ? "MOVED" : "REMOVED", studentGroupId, subjectId, from: slot, to: target ?? null });
    });
    for (const slot of to.slice(from.length)) {
      moves.push({ kind: "ADDED", studentGroupId, subjectId, from: null, to: slot });
    }
  }
  for (const rest of candidateByLine.values()) {
    for (const slot of rest.map(slotOf).sort(byClock)) {
      moves.push({ kind: "ADDED", studentGroupId: rest[0]!.studentGroupId, subjectId: rest[0]!.subjectId, from: null, to: slot });
    }
  }

  return moves.sort((a, b) => byClock((a.from ?? a.to)!, (b.from ?? b.to)!));
}

/**
 * The draft lessons a candidate does not keep at their slot: what the
 * gateway calls `moved`, so the list and the table's "X av Y" agree.
 */
export function movedCount(moves: readonly MovedLesson[]): number {
  return moves.filter((move) => move.kind === "MOVED" || move.kind === "REMOVED").length;
}
