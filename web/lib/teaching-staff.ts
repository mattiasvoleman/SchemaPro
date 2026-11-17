/**
 * "Personal som undervisar": a TEACHER, and a SCHOOL_ADMIN who teaches
 * (Users.teaches, set by rektor or a full administrator). The web's copy of
 * the gateway's `teachesLike` (src/staffing/teaching-staff.ts), so that the
 * places that ask "who may be put on a lesson, a post, an activity or an
 * absence" cannot disagree with the gateway about what a teaching
 * administrator is. A source-reading test (teaching-staff.contract.test.ts)
 * holds the two to the same sentence.
 *
 * The rule for using it, which is a decision and not a style: a PICK of who
 * teaches takes this; a LOOK-UP of the name of the person a lesson or post
 * already carries takes anybody in the list (a mark taken off later must not
 * leave her lesson without a name); and a pick of who may STEP IN (the
 * substitute, the cover board) or be a klasslärare stays `role === "TEACHER"`:
 * a teaching administrator is not in the pool and is never asked (SP409, CT400).
 *
 * A file of its own, with no imports but types, on purpose: the pages that
 * use it sit close to their bundle budgets, and a function in a large shared
 * module takes the whole module with it (bundle-gate-measurement).
 */
export function teachesLike(person: { role: string; teaches?: boolean | null }): boolean {
  return person.role === "TEACHER" || (person.role === "SCHOOL_ADMIN" && person.teaches === true);
}
