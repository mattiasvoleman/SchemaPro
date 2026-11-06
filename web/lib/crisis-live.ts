import type { CallBasis, CallView, PupilStatus, PupilView } from "@/lib/crisis-types";

/*
 * The figures of the administration's live view, worked out from the groups
 * the gateway answered (GET /crisis/alarms/:id) and from nothing else, so the
 * counters, the lists and the table can never disagree with one another.
 */

export interface LiveFigures {
  /** Groups with nobody left to ask, of all groups. */
  groupsDone: number;
  groups: number;
  pupils: number;
  found: number;
  missing: number;
  unreported: number;
  absentBefore: number;
  /** Teachers (each once, however many groups they answer for) who owe no answer, of all. */
  teachersAnswered: number;
  teachers: number;
}

/** A group is done when every expected pupil has a mark (the gateway's rule for callsComplete). */
export const isDone = (call: Pick<CallView, "counts">): boolean => call.counts.unreported === 0;

export type CallState = "DONE" | "DONE_MISSING" | "IN_PROGRESS" | "WAITING";

/**
 * Where a group stands, in one word. Said in text and an icon on the page,
 * never in colour alone.
 */
export function callState(call: Pick<CallView, "counts">): CallState {
  const { counts } = call;
  if (counts.unreported === 0) return counts.missing > 0 ? "DONE_MISSING" : "DONE";
  return counts.found + counts.missing > 0 ? "IN_PROGRESS" : "WAITING";
}

/**
 * The groups as the live view lists them: the one of pupils on no lesson first (nobody answers for
 * it, so it is the administration's own list), the rest in the order the gateway gave.
 */
export function groupsInOrder<T extends Pick<CallView, "basis">>(calls: readonly T[]): T[] {
  return [...calls.filter((call) => call.basis === "NO_LESSON"), ...calls.filter((call) => call.basis !== "NO_LESSON")];
}

export interface SilentTeacher {
  userId: string;
  name: string;
  /** The groups they have not answered for. */
  groups: string[];
}

/**
 * The teachers who owe an answer: those with a group that still has pupils to
 * ask after and on which they have not marked anyone. A colleague's marks, or
 * the administration's, that finish the group release them.
 */
export function silentTeachers(calls: readonly CallView[]): SilentTeacher[] {
  const byId = new Map<string, SilentTeacher>();
  for (const call of calls) {
    if (isDone(call)) continue;
    for (const teacher of call.teachers) {
      if (teacher.userId === null || teacher.answeredAt !== null) continue;
      const entry = byId.get(teacher.userId) ?? { userId: teacher.userId, name: teacher.name ?? "", groups: [] };
      entry.groups.push(call.groupName);
      byId.set(teacher.userId, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

export function liveFigures(calls: readonly CallView[]): LiveFigures {
  const teachers = new Set<string>();
  for (const call of calls) for (const teacher of call.teachers) if (teacher.userId !== null) teachers.add(teacher.userId);
  const figures: LiveFigures = {
    groupsDone: calls.filter(isDone).length,
    groups: calls.length,
    pupils: 0,
    found: 0,
    missing: 0,
    unreported: 0,
    absentBefore: 0,
    teachersAnswered: teachers.size - silentTeachers(calls).length,
    teachers: teachers.size,
  };
  for (const call of calls) {
    figures.pupils += call.counts.pupils;
    figures.found += call.counts.found;
    figures.missing += call.counts.missing;
    figures.unreported += call.counts.unreported;
    figures.absentBefore += call.counts.absentBefore;
  }
  return figures;
}

export interface PupilToFind {
  callId: string;
  pupil: PupilView;
  basis: CallBasis;
  groupName: string;
  subjectName: string;
  roomName: string | null;
  /** Who answers for the group, for the administration to ask; empty when nobody does. */
  teachers: string[];
}

/**
 * The pupils still to find, or still to hear about: the missing first, then the unreported, each by
 * group and name; within each, the pupils on no lesson before the groups with a teacher to ask.
 */
export function pupilsToFind(calls: readonly CallView[]): PupilToFind[] {
  const rows: PupilToFind[] = [];
  for (const call of calls) {
    for (const pupil of call.pupils) {
      if (pupil.status !== "MISSING" && pupil.status !== "UNREPORTED") continue;
      rows.push({
        callId: call.id,
        pupil,
        basis: call.basis,
        groupName: call.groupName,
        subjectName: call.subjectName,
        roomName: call.roomName,
        teachers: call.teachers.flatMap((teacher) => (teacher.name ? [teacher.name] : [])),
      });
    }
  }
  const rank = (status: PupilStatus) => (status === "MISSING" ? 0 : 1);
  const name = (row: PupilToFind) => `${row.pupil.lastName} ${row.pupil.firstName}`;
  const unlisted = (row: PupilToFind) => (row.basis === "NO_LESSON" ? 0 : 1);
  return rows.sort(
    (a, b) =>
      rank(a.pupil.status) - rank(b.pupil.status) ||
      unlisted(a) - unlisted(b) ||
      a.groupName.localeCompare(b.groupName, "sv") ||
      name(a).localeCompare(name(b), "sv"),
  );
}
