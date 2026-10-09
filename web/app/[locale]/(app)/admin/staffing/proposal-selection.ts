import { loadStatus, percentOfTarget, type LoadStatus } from "@/lib/teacher-load";
import type { ProposalAssignment, ProposalTeacher, StaffingChange, StaffingProposal } from "./use-staffing-proposal";

/*
 * What the dialog's selection does to each teacher, in the gateway's own
 * arithmetic (lib/teacher-load.ts mirrors src/staffing/teacher-load.ts).
 *
 * The proposal says where every teacher ends if ALL its changes are applied.
 * The admin may leave some out; each row's charge is exact to two decimals in
 * the answer, so a teacher's minutes under a selection are the proposal's
 * after with the left-out rows given back: a row moved TO the teacher is taken
 * off, a row moved FROM the teacher is put back. Loads are additive per row
 * (countedMinutesByTeacher sums one charge per lead), so this is the
 * gateway's own figure, not an estimate.
 *
 * The status is then judged with loadStatus, and only a teacher whose minutes
 * GROW is flagged — enforcement's question (overTargetFinding returns nothing
 * for a load that does not grow), so the dialog never warns about a teacher
 * the apply will not ask about.
 */

export interface SelectedLoad {
  /** Whole minutes, as the matrix prints them. */
  minutes: number;
  exact: number;
  percentOfTarget: number | null;
  status: LoadStatus;
  /** The selection gives the teacher more than they have today. */
  grows: boolean;
  /** Grows AND ends OVER: the apply will ask the school's over-allocation question. */
  overLimit: boolean;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function loadsUnderSelection(
  proposal: Pick<StaffingProposal, "teachers" | "assignments">,
  selected: ReadonlySet<string>,
  tolerancePercent: number,
): Map<string, SelectedLoad> {
  const leftOut = new Map<string, number>();
  for (const assignment of proposal.assignments) {
    if (selected.has(assignment.requirementId)) continue;
    const charge = assignment.chargeMinutesPerWeek;
    leftOut.set(assignment.toTeacherId, (leftOut.get(assignment.toTeacherId) ?? 0) - charge);
    if (assignment.fromTeacherId !== null) {
      leftOut.set(assignment.fromTeacherId, (leftOut.get(assignment.fromTeacherId) ?? 0) + charge);
    }
  }
  const loads = new Map<string, SelectedLoad>();
  for (const teacher of proposal.teachers) {
    const delta = leftOut.get(teacher.userId);
    // Every change selected (or none of this teacher's left out): the
    // gateway's own figures, unrounded by a second computation.
    const exact = delta === undefined ? teacher.after.countedExact : round2(teacher.after.countedExact + delta);
    const status =
      delta === undefined ? teacher.after.status : loadStatus(exact, teacher.targetMinutesPerWeek, tolerancePercent);
    const grows = exact > teacher.before.countedExact + 1e-9;
    loads.set(teacher.userId, {
      minutes: delta === undefined ? teacher.after.countedMinutesPerWeek : Math.round(exact),
      exact,
      percentOfTarget:
        delta === undefined ? teacher.after.percentOfTarget : percentOfTarget(exact, teacher.targetMinutesPerWeek),
      status,
      grows,
      overLimit: grows && status === "OVER",
    });
  }
  return loads;
}

/** The teachers a change touches — the ones listed first, before "Visa alla". */
export function touchedTeachers(assignments: readonly ProposalAssignment[]): Set<string> {
  const touched = new Set<string>();
  for (const assignment of assignments) {
    touched.add(assignment.toTeacherId);
    if (assignment.fromTeacherId !== null) touched.add(assignment.fromTeacherId);
  }
  return touched;
}

/**
 * The teachers in the order the dialog lists them: those a change touches
 * first, then the rest, each part in the gateway's order (by id) re-sorted by
 * the name the page knows them by.
 */
export function orderedTeachers(
  teachers: readonly ProposalTeacher[],
  touched: ReadonlySet<string>,
  nameOf: (userId: string) => string,
): ProposalTeacher[] {
  const byName = (a: ProposalTeacher, b: ProposalTeacher) => nameOf(a.userId).localeCompare(nameOf(b.userId), "sv");
  return [
    ...teachers.filter((teacher) => touched.has(teacher.userId)).sort(byName),
    ...teachers.filter((teacher) => !touched.has(teacher.userId)).sort(byName),
  ];
}

/** The apply body's changes: the selected rows, from their lead today to the proposed one. */
export function selectedChanges(
  assignments: readonly ProposalAssignment[],
  selected: ReadonlySet<string>,
): StaffingChange[] {
  return assignments
    .filter((assignment) => selected.has(assignment.requirementId))
    .map((assignment) => ({
      requirementId: assignment.requirementId,
      fromTeacherId: assignment.fromTeacherId,
      toTeacherId: assignment.toTeacherId,
    }));
}

/**
 * The undo of an apply: the same rows, each back from the proposed lead to the
 * one it had — which may be nobody (an open row) or a teacher who has left (a
 * vacated row); the gateway accepts both only with `undo: true`.
 */
export function reversed(changes: readonly StaffingChange[]): StaffingChange[] {
  return changes.map((change) => ({
    requirementId: change.requirementId,
    fromTeacherId: change.toTeacherId,
    toTeacherId: change.fromTeacherId,
  }));
}
