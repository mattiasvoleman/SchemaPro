import type { AcademicYear, YearRosters } from "@/lib/types";

/*
 * FÖRBERÄKNADE KLASSLISTOR, on the web side.
 *
 * A year made by the rollover is inactive until the old one has ended. Until
 * then its classes have no home pupils — Users.studentGroupId still points at
 * this year's classes — so a page that builds studentGroupOf or homeClassOf
 * from the people list would see next year's 8A empty, draw no clash between
 * 8A and the maths group most of 8A sits in, and derive no årskurs for a
 * teaching group whose members are all on their way up.
 *
 * The gateway computes, for such a year, the home class its activation WOULD
 * give each pupil it moves (src/year-rollover/projected-rosters.ts: planMoves
 * and homeClassOverlay, the code the activation itself runs), and every
 * server-side reader — generation, room proposals, lunch headcounts, a lesson
 * placed by hand, grade spans — reads the year through it. GET
 * /academic-years/:id/rosters hands the web exactly that overlay, so the grid's
 * clash colours and the pages' grade spans agree with what the server will
 * check. Nothing here re-derives a move: the server's rows are laid over the
 * people as they come, which is what makes them equal to the rows the
 * activation will write.
 */

/**
 * The years a planning page offers: the active one, and the year rolled from
 * it while it is not yet activated — the one year the gateway projects (rule
 * R5). A year two steps ahead, or any year of a school with no active year,
 * is refused by every server reader until its predecessor is activated (R6),
 * so it is not offered; a past year has its own rows and is not planned.
 */
export function planningChoices(years: readonly AcademicYear[] | undefined): {
  active: AcademicYear | null;
  successor: AcademicYear | null;
} {
  const active = years?.find((year) => year.isActive) ?? null;
  const successor =
    active === null
      ? null
      : (years?.find((year) => !year.isActive && year.predecessorId === active.id) ?? null);
  return { active, successor };
}

/**
 * Whether the gateway can answer PROJECTED for `year` at all — and so whether
 * the rosters are worth asking for. Every other year comes back CURRENT with
 * an empty list (its rows are its rosters) or as a 409, so the active year's
 * page makes no extra request.
 */
export function isProjectable(year: AcademicYear | null, active: AcademicYear | null): boolean {
  return year !== null && active !== null && !year.isActive && year.predecessorId === active.id;
}

/**
 * The people with the server's projected home classes laid over them.
 *
 * Only the pupils in `homeClasses` change, and to exactly the class (or the
 * null) the server sent; everyone else is returned as is — teachers, pupils
 * already in the year, inactive pupils, who stay in last year's class at the
 * activation too. With nothing to lay over, the same array comes back, so a
 * memo keyed on it does not recompute.
 */
export function withProjectedHomes<P extends { id: string; studentGroupId: string | null }>(
  people: P[] | undefined,
  rosters: YearRosters | null | undefined,
): P[] | undefined {
  if (!people || !rosters || rosters.basis !== "PROJECTED" || rosters.homeClasses.length === 0) {
    return people;
  }
  const homeOf = new Map(rosters.homeClasses.map((row) => [row.studentId, row.studentGroupId]));
  return people.map((person) =>
    homeOf.has(person.id) ? { ...person, studentGroupId: homeOf.get(person.id)! } : person,
  );
}

/**
 * The rosters' react-query key, per year.
 *
 * Under the people list's own prefix on purpose: the overlay is a function of
 * the pupils' home classes, so every write that makes ["people"] stale — a
 * pupil's class changed on the people page, an import, an activation
 * (AFTER_ACTIVATION in lib/year-keys.ts) — makes it stale with it, and no
 * mutation has to know this key exists. A teaching group's members change the
 * membership counts only; useSetGroupMembers invalidates this prefix by name.
 */
export const YEAR_ROSTERS_KEY = ["people", "yearRosters"] as const;
