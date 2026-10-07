import type { TeacherDutyKind } from '@prisma/client';

/**
 * When two uppdrag are "the same one": the same teacher, the same kind, and a
 * label equal once trimmed and lowercased — what a human means by "Rastvakt"
 * and "rastvakt ". The uppdrag import updates the row of that identity rather
 * than adding a second, and the carry of tjänster into an already rolled year
 * (staffing Fas 5) treats a target duty of that identity as already there.
 * One definition, so the two never disagree about whether a row exists.
 */
export function normalizeDutyLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function dutyIdentity(userId: string, kind: TeacherDutyKind, label: string): string {
  return `${userId}:${kind}:${normalizeDutyLabel(label)}`;
}
