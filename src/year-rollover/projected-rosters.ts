import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import { chainOf, homeClassOverlay, planActivation, readActivationSource } from './activation-plan';

/**
 * Förberäknade klasslistor: the rosters of a läsår that the rollover created
 * and that is not activated yet, as its activation WOULD leave them.
 *
 * WHY. A rolled year waits, with empty classes, until the old year has ended
 * and it is activated (activation-plan.ts says why the pupils do not move in
 * May). Its teaching groups' copied members still have last year's classes as
 * their home class: Ma8's pupils are in 7A, not in 8A. Pupil clashes, room
 * sizes, lunch headcounts and grade spans are all read from the home classes,
 * so a timetable generated in spring for that year saw nobody — and the
 * gateway refused it (ROLLOVER_NOT_ACTIVATED) rather than plan it wrong.
 *
 * WHAT. Every roster reader of such a year sees the current rows with one
 * change laid over them in memory: the home class the activation would write
 * for each pupil it moves. `homeOf` is `homeClassOverlay` of the plan the
 * activation itself executes — planActivation over readActivationSource — so
 * there is ONE projection, shared with the activation, and never a second
 * hand-written mapping. Moved pupils get the year's class; graduates and
 * unplaced pupils get none; everybody else, the inactive included, keeps the
 * class they have. StudentGroupMembers are read as they are: the activation
 * does not touch them either. Nothing here writes.
 *
 * THE BASIS, decided structurally and never by `today`. YEAR_IS_SUPERSEDED and
 * YEAR_ACTIVATION_TOO_EARLY block an activation; they never pick a basis. A
 * year a PostgREST insert has put after the successor, with one newcomer in
 * it, supersedes the successor — and the successor must still read the
 * projection, not its empty classes.
 *
 *   R1  the active year                                  CURRENT (no statement with `known`)
 *   R2  a year outside every chain (no predecessor)      CURRENT (no statement with `known`)
 *   R3  a year RLS hides                                 CURRENT; the reader answers its own 404
 *   R4  a past year (in the active year's chain)         CURRENT
 *   R5  the active year's immediate successor            PROJECTED when the plan writes, else CURRENT
 *   R6  any other year whose plan still writes           409 ROLLOVER_NOT_ACTIVATED: activate its predecessor first
 *
 * R6 is a refusal, not a guess. Two not-yet-activated years in one chain only
 * arise through PostgREST (the API refuses to roll a year that still has
 * moves pending, ROLLOVER_SOURCE_NOT_ACTIVATED), and walking straight through
 * them is not what activating them one after the other does: a pupil whose
 * successor in B is a teaching group is unplaced at B's activation, and would
 * land in C's 9A if walked straight to C. A school with no active year at all
 * is refused the same way.
 *
 * STAFF ONLY. The source reads are school-wide: every year, group, pupil and
 * teaching-group membership. Under SCHOOL_ADMIN and TEACHER RLS those are
 * the school's (users_staff_select, student_groups_staff_select,
 * student_group_members_staff_select, academic_years_member_select), so a
 * teacher computes exactly the admin's projection from rows they may already
 * read. Under a pupil's or a guardian's they degenerate to the caller's own
 * row, and the projection would be silently wrong — so it is refused.
 */

/** A roster read of a läsår whose predecessor has not been activated (R6). */
export const ROLLOVER_NOT_ACTIVATED = 'ROLLOVER_NOT_ACTIVATED';

export interface CurrentRosters {
  kind: 'CURRENT';
}

export interface ProjectedRosters {
  kind: 'PROJECTED';
  /** studentId → the class the activation gives them in the year, or null (graduate, unplaced). */
  homeOf: ReadonlyMap<string, string | null>;
  counts: { moved: number; graduates: number; unplaced: number };
  /** planActivation's MEMBERSHIPS_OUT_OF_DATE, zero when it has none. */
  membershipsOutOfDate: { missing: number; stale: number };
}

export type RosterBasis = CurrentRosters | ProjectedRosters;

/** The year's own flags, where the reader has already read the year row. */
export interface YearFlags {
  isActive: boolean;
  predecessorId: string | null;
}

/**
 * The years R1 and R2 settle as CURRENT without reading anything more: the
 * active year, and a year outside every chain.
 *
 * For a reader that can only COUNT the year inside a statement it already
 * makes. Prisma 7 loads a selected relation (a lesson's `academicYear`) in a
 * statement of its own, but a relation count (`_count`) with this filter is
 * a join inside the statement that carries it. A reader that has the count
 * passes `{ settledCurrent: count > 0 }` as `known`.
 */
export const SETTLED_CURRENT: Prisma.AcademicYearWhereInput = { OR: [{ isActive: true }, { predecessorId: null }] };

/** What a relation count over SETTLED_CURRENT tells: true is CURRENT, false asks the year. */
export interface SettledCount {
  settledCurrent: boolean;
}

/** Who asks: the projection is computed for staff only. */
export interface RosterViewer {
  role: Role | string;
}

/** A basis, or what a reader that may not need one knows to compute it lazily. */
export type BasisOrYear = RosterBasis | { viewer: RosterViewer; known?: YearFlags | SettledCount };

const CURRENT: CurrentRosters = Object.freeze({ kind: 'CURRENT' });

const STAFF: ReadonlySet<string> = new Set([Role.SCHOOL_ADMIN, Role.TEACHER]);

/**
 * The basis every roster reader of the year reads through. Computed once per
 * request and passed down.
 *
 * `known` is the year's flags from a row the reader already read: the active
 * year and a year outside every chain then cost no statement at all, which is
 * what keeps a lesson dragged in this year's grundschema as cheap as it was.
 * A SettledCount does the same for R1 and R2 when it is true; false says only
 * that the year is neither, and the flags are read. Without either, one
 * primary-key read. From R4 on, the four school-wide reads of
 * readActivationSource.
 */
export async function rostersOfYear(
  tx: Prisma.TransactionClient,
  viewer: RosterViewer,
  academicYearId: string,
  known?: YearFlags | SettledCount,
): Promise<RosterBasis> {
  if (!STAFF.has(viewer.role)) {
    throw new ForbiddenException('Klasslistor räknas bara fram för personal.');
  }
  if (known && 'settledCurrent' in known) {
    if (known.settledCurrent) return CURRENT; // R1 or R2
    known = undefined;
  }
  let flags: Partial<YearFlags> | null | undefined = known;
  if (!flags) {
    flags = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { isActive: true, predecessorId: true },
    });
    if (!flags) return CURRENT; // R3
  }
  if (flags.isActive === true) return CURRENT; // R1
  if (!flags.predecessorId) return CURRENT; // R2

  const source = await readActivationSource(tx, academicYearId);
  if (!source) return CURRENT; // R3
  const year = source.years.find((candidate) => candidate.id === academicYearId)!;
  if (year.isActive) return CURRENT; // R1, activated since the flags were read
  const active = source.years.find((candidate) => candidate.isActive) ?? null;
  if (active && chainOf(source.years, active.id).some((past) => past.id === academicYearId)) {
    return CURRENT; // R4
  }
  // The same call rollover-source.ts makes for pendingMoves, and the plan the
  // execute writes: a date after every year's end, so the walk is the whole of
  // it and nothing is decided by today.
  const plan = planActivation(source, '9999-12-31');
  if (plan.writes.length === 0) return CURRENT;
  if (!active || year.predecessorId !== active.id) {
    const predecessor = source.years.find((candidate) => candidate.id === year.predecessorId);
    throw notActivated(year.name, predecessor?.name ?? '');
  }
  const homeOf = homeClassOverlay(plan);
  let moved = 0;
  for (const target of homeOf.values()) if (target !== null) moved++;
  const memberships = plan.problems.find((problem) => problem.code === 'MEMBERSHIPS_OUT_OF_DATE');
  return {
    kind: 'PROJECTED',
    homeOf,
    counts: { moved, graduates: plan.graduates.count, unplaced: plan.unplaced.count },
    membershipsOutOfDate: {
      missing: Number(memberships?.params['missing'] ?? 0),
      stale: Number(memberships?.params['stale'] ?? 0),
    },
  };
}

/** R6's 409, the same at every site and on the GET. */
export function notActivated(year: string, predecessor: string): ConflictException {
  return new ConflictException({
    message:
      `${year} kan inte schemaläggas ännu: föregående läsår ${predecessor} är inte aktiverat. ` +
      `Aktivera ${predecessor} först.`,
    code: ROLLOVER_NOT_ACTIVATED,
    params: { year, predecessor },
  });
}

// ---- the read helpers

/**
 * The filters a roster reader puts on Users beside the class, as it writes
 * them. Only these three: a pupil the overlay adds is an active STUDENT by
 * construction (planMoves moves nobody else), so `role` and `isActive` hold
 * for it, and an `id` filter is applied to it here. Anything else could not
 * be judged for an added pupil without reading them, so the type refuses it.
 */
export interface HomeWhere {
  role?: 'STUDENT';
  isActive?: true;
  id?: { in: string[] };
}

export interface HomeRow {
  id: string;
  studentGroupId: string | null;
}

/**
 * For a reader that keeps its own query: the rows it read, with the
 * projection laid over them. CURRENT returns them as they are (in the
 * database's order, as before). PROJECTED drops every row whose pupil the
 * overlay moves — by STUDENT ID, not by the class it came from, so a read
 * that runs after an activation committed between the basis and the roster
 * still counts each pupil once — and adds the overlay's pupils whose new class
 * is one of `groupIds`, sorted by id.
 */
export function overlayHomeRows(
  basis: RosterBasis,
  rows: readonly HomeRow[],
  groupIds: string | readonly string[],
  where: HomeWhere = {},
): HomeRow[] {
  if (basis.kind === 'CURRENT') return [...rows];
  const wanted = new Set(typeof groupIds === 'string' ? [groupIds] : groupIds);
  const onlyIds = where.id ? new Set(where.id.in) : null;
  const kept = rows.filter((row) => !basis.homeOf.has(row.id));
  for (const [studentId, target] of basis.homeOf) {
    if (target === null || !wanted.has(target)) continue;
    if (onlyIds && !onlyIds.has(studentId)) continue;
    kept.push({ id: studentId, studentGroupId: target });
  }
  return kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const classFilter = (groupIds: string | readonly string[]) =>
  typeof groupIds === 'string' ? groupIds : { in: [...groupIds] };

/** Pupils whose home class is one of `groupIds`, under the reader's own filters. */
export async function readHomePupils(
  tx: Prisma.TransactionClient,
  basis: RosterBasis,
  where: HomeWhere,
  groupIds: string | readonly string[],
): Promise<HomeRow[]> {
  const rows = await tx.user.findMany({
    where: { ...where, studentGroupId: classFilter(groupIds) },
    select: { id: true, studentGroupId: true },
  });
  return overlayHomeRows(basis, rows ?? [], groupIds, where);
}

/**
 * How many pupils have one of `groupIds` as their home class. CURRENT is the
 * reader's own count; PROJECTED reads the ids instead, since a pupil the
 * overlay moves out has to be dropped by id.
 */
export async function countHomePupils(
  tx: Prisma.TransactionClient,
  basis: RosterBasis,
  where: HomeWhere,
  groupIds: string | readonly string[],
): Promise<number> {
  if (basis.kind === 'CURRENT') {
    return (await tx.user.count({ where: { ...where, studentGroupId: classFilter(groupIds) } })) ?? 0;
  }
  return (await readHomePupils(tx, basis, where, groupIds)).length;
}

/** Each named pupil's home class, as the year's activation would leave it. */
export async function readHomeClassesOf(
  tx: Prisma.TransactionClient,
  basis: RosterBasis,
  studentIds: readonly string[],
): Promise<HomeRow[]> {
  const rows =
    (await tx.user.findMany({
      where: { id: { in: [...studentIds] } },
      select: { id: true, studentGroupId: true },
    })) ?? [];
  if (basis.kind === 'CURRENT') return rows;
  return rows
    .map((row) => (basis.homeOf.has(row.id) ? { id: row.id, studentGroupId: basis.homeOf.get(row.id) ?? null } : row))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
