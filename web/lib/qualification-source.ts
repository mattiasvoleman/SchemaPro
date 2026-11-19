import type { Subject } from "@/lib/types";

/*
 * Behörighet som i ett annat ämne (Subject.qualificationSubjectId), the two
 * questions a screen asks of the school's subject list. The rule itself is the
 * gateway's (qualification-inheritance.ts): this is only who may be chosen and
 * who is named. One level: a subject that uses another's behörighet is never a
 * source, and a source never uses one.
 */

/** The subjects `self` may take its behörighet from: the school's others that take none themselves. */
export function qualificationSourceChoices(subjects: readonly Subject[], self: Subject | null): Subject[] {
  return subjects.filter((subject) => subject.id !== self?.id && !subject.qualificationSubjectId);
}

/** The subjects that use `subjectId`'s behörighet. */
export function qualificationUsers(subjects: readonly Subject[], subjectId: string): Subject[] {
  return subjects.filter((subject) => subject.qualificationSubjectId === subjectId);
}
