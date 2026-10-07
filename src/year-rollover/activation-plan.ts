import { createHash } from 'node:crypto';
import type { PrismaClient, StudentGroupKind } from '@prisma/client';

/**
 * Who moves where when a läsår is activated: the pupils of the years before
 * it, along the group links the rollover wrote (7A → 8A), into its classes.
 *
 * WHY AT ACTIVATION AND NOT AT THE ROLLOVER. The rollover is done in spring,
 * while the old year still runs. A pupil's home class (Users.studentGroupId) is
 * what attendance builds its rosters from and what a pupil and a guardian read
 * the schedule through, so moving it in May would empty 7A's remaining
 * lessons. The new year's classes wait, linked and empty, until the year they
 * belong to is activated.
 *
 * PLANNED, THEN EXECUTED. `planActivation` is pure over what
 * `readActivationSource` read. The preview returns the plan and its hash; the
 * execute locks, re-reads, plans again and compares — so the pupils moved are
 * exactly the ones the admin saw, by id, or nobody is moved.
 *
 * NEVER BY graduatingGradeLevel. That column only LABELS a pupil whose chain
 * of successors breaks: a graduate when their class was at or above it, an
 * unplaced pupil otherwise. Both end with no class; nothing is moved on its
 * account, so an admin who changes it through PostgREST changes a label.
 */

export interface ActivationYear {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  startDate: string;
  endDate: string;
  isActive: boolean;
  predecessorId: string | null;
  graduatingGradeLevel: number | null;
}

export interface ActivationGroup {
  id: string;
  name: string;
  academicYearId: string;
  kind: StudentGroupKind;
  gradeLevel: number | null;
  predecessorId: string | null;
}

export interface ActivationStudent {
  id: string;
  isActive: boolean;
  studentGroupId: string | null;
}

export interface ActivationSource {
  yearId: string;
  /** Every läsår of the school. */
  years: ActivationYear[];
  /** Every group of the school. */
  groups: ActivationGroup[];
  /** Every pupil of the school, active or not. */
  students: ActivationStudent[];
}

/** How many links the chain is followed back; a school rolls once a year. */
export const MAX_CHAIN_HOPS = 10;

export type UnplacedReason = 'NO_SUCCESSOR' | 'SUCCESSOR_NOT_A_CLASS';

export interface ActivationMove {
  fromGroupId: string;
  fromGroupName: string;
  /** Null: the pupil leaves with no class (graduate or unplaced). */
  toGroupId: string | null;
  toGroupName: string | null;
  studentIds: string[];
}

export type ActivationProblemCode = 'YEAR_ACTIVATION_TOO_EARLY' | 'YEAR_IS_SUPERSEDED';

export interface ActivationProblem {
  code: ActivationProblemCode;
  blocking: true;
  params: Record<string, string | number>;
}

export interface ActivationPlan {
  year: { id: string; name: string; isActive: boolean };
  currentlyActive: { id: string; name: string } | null;
  chain: { id: string; name: string; endDate: string }[];
  /** Pupils moved into a class of the year, per (from, to) pair. */
  moves: { fromGroupId: string; fromGroupName: string; toGroupId: string; toGroupName: string; count: number }[];
  graduates: { count: number; studentIds: string[] };
  unplaced: {
    count: number;
    studentIds: string[];
    pupils: { studentId: string; fromGroupId: string; reason: UnplacedReason }[];
  };
  alreadyInYear: number;
  inLaterYear: number;
  otherOrNone: number;
  inactiveUntouched: number;
  problems: ActivationProblem[];
  blocking: boolean;
  planHash: string;
  /** Every pupil whose class the execute writes, (from, to) pairs included. Not part of the response. */
  writes: ActivationMove[];
}

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * The rows the plan is computed from, in the caller's transaction. All of the
 * school's years, groups and pupils: three statements, each a few hundred
 * rows for a large school, and the only way to tell "already in the year",
 * "in a later year" and "in no year at all" apart. RLS confines all three to
 * the caller's school. Null when RLS hides the year.
 */
export async function readActivationSource(
  tx: PrismaClient,
  yearId: string,
): Promise<ActivationSource | null> {
  const years = await tx.academicYear.findMany({
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      isActive: true,
      predecessorId: true,
      graduatingGradeLevel: true,
    },
  });
  if (!(years ?? []).some((year) => year.id === yearId)) return null;
  const groups = await tx.studentGroup.findMany({
    select: { id: true, name: true, academicYearId: true, kind: true, gradeLevel: true, predecessorId: true },
  });
  const students = await tx.user.findMany({
    where: { role: 'STUDENT' },
    select: { id: true, isActive: true, studentGroupId: true },
  });
  return {
    yearId,
    years: years.map((year) => ({
      ...year,
      startDate: asDay(year.startDate),
      endDate: asDay(year.endDate),
    })),
    groups: groups ?? [],
    students: students ?? [],
  };
}

/** The year's predecessors, nearest first, at most MAX_CHAIN_HOPS. */
export function chainOf(years: readonly ActivationYear[], yearId: string): ActivationYear[] {
  const byId = new Map(years.map((year) => [year.id, year]));
  const chain: ActivationYear[] = [];
  const seen = new Set([yearId]);
  let at = byId.get(yearId);
  while (at?.predecessorId && chain.length < MAX_CHAIN_HOPS) {
    const previous = byId.get(at.predecessorId);
    if (!previous || seen.has(previous.id)) break;
    seen.add(previous.id);
    chain.push(previous);
    at = previous;
  }
  return chain;
}

/** Years whose own chain reaches `yearId`: its successor, and theirs. */
function laterYearsOf(years: readonly ActivationYear[], yearId: string): Set<string> {
  const later = new Set<string>();
  for (const year of years) {
    if (year.id === yearId) continue;
    if (chainOf(years, year.id).some((previous) => previous.id === yearId)) later.add(year.id);
  }
  return later;
}

/**
 * The activation of `source.yearId` as of `today` (YYYY-MM-DD, Europe/
 * Stockholm). Pure.
 *
 * For each active pupil whose home class is in a year of the chain, the
 * successor links are followed into the year. The class reached must be a
 * CLASS — a successor someone turned into a TEACHING_GROUP is no home class,
 * and the pupil is unplaced (SUCCESSOR_NOT_A_CLASS). A chain that breaks
 * leaves the pupil with no class: a graduate when the group it broke at was
 * at or above the next year's graduatingGradeLevel, unplaced otherwise.
 * Pupils already in the year, in a later year, in an unrelated year or in no
 * class, and inactive pupils, are counted and left alone.
 */
export function planActivation(source: ActivationSource, today: string): ActivationPlan {
  const yearById = new Map(source.years.map((year) => [year.id, year]));
  const year = yearById.get(source.yearId)!;
  const chain = chainOf(source.years, year.id);
  const chainIds = new Set(chain.map((previous) => previous.id));
  const later = laterYearsOf(source.years, year.id);
  const groupById = new Map(source.groups.map((group) => [group.id, group]));
  const successorOf = new Map<string, ActivationGroup>();
  for (const group of source.groups) {
    if (group.predecessorId) successorOf.set(group.predecessorId, group);
  }
  // The year after each chain year, toward `year`: whose G labels a break.
  const nextYearOf = new Map<string, ActivationYear>();
  for (const [index, previous] of chain.entries()) {
    nextYearOf.set(previous.id, index === 0 ? year : chain[index - 1]!);
  }

  const writes = new Map<string, ActivationMove>();
  const record = (from: ActivationGroup, to: ActivationGroup | null, studentId: string) => {
    const key = `${from.id}>${to?.id ?? ''}`;
    let move = writes.get(key);
    if (!move) {
      move = {
        fromGroupId: from.id,
        fromGroupName: from.name,
        toGroupId: to?.id ?? null,
        toGroupName: to?.name ?? null,
        studentIds: [],
      };
      writes.set(key, move);
    }
    move.studentIds.push(studentId);
  };

  const graduates: string[] = [];
  const unplaced: ActivationPlan['unplaced']['pupils'] = [];
  let alreadyInYear = 0;
  let inLaterYear = 0;
  let otherOrNone = 0;
  let inactiveUntouched = 0;
  // The last day of the years whose pupils move: activation waits for it.
  let runsUntil: { date: string; name: string } | null = null;

  for (const student of source.students) {
    const home = student.studentGroupId ? groupById.get(student.studentGroupId) : undefined;
    if (!student.isActive) {
      if (home && chainIds.has(home.academicYearId)) inactiveUntouched++;
      continue;
    }
    if (!home) {
      otherOrNone++;
      continue;
    }
    if (home.academicYearId === year.id) {
      alreadyInYear++;
      continue;
    }
    if (later.has(home.academicYearId)) {
      inLaterYear++;
      continue;
    }
    if (!chainIds.has(home.academicYearId)) {
      otherOrNone++;
      continue;
    }

    const homeYear = yearById.get(home.academicYearId)!;
    if (runsUntil === null || homeYear.endDate > runsUntil.date) {
      runsUntil = { date: homeYear.endDate, name: homeYear.name };
    }
    let at = home;
    let hops = 0;
    while (at.academicYearId !== year.id && hops <= MAX_CHAIN_HOPS) {
      const next = successorOf.get(at.id);
      if (!next) break;
      at = next;
      hops++;
    }
    if (at.academicYearId === year.id) {
      if (at.kind === 'CLASS') {
        record(home, at, student.id);
      } else {
        record(home, null, student.id);
        unplaced.push({ studentId: student.id, fromGroupId: home.id, reason: 'SUCCESSOR_NOT_A_CLASS' });
      }
      continue;
    }
    record(home, null, student.id);
    const graduating = nextYearOf.get(at.academicYearId)?.graduatingGradeLevel ?? null;
    if (at.gradeLevel !== null && graduating !== null && at.gradeLevel >= graduating) {
      graduates.push(student.id);
    } else {
      unplaced.push({ studentId: student.id, fromGroupId: home.id, reason: 'NO_SUCCESSOR' });
    }
  }

  const problems: ActivationProblem[] = [];
  if (runsUntil !== null && today <= runsUntil.date) {
    problems.push({
      code: 'YEAR_ACTIVATION_TOO_EARLY',
      blocking: true,
      params: { year: runsUntil.name, endDate: runsUntil.date },
    });
  }
  // A year that a later year of its own chain already holds the pupils of:
  // activating it again would leave it active with empty classes (and the
  // year that holds them inactive). Any later year counts, not only the
  // direct successor — after A → B → C with everyone in C, B is empty, and
  // looking one link ahead from A found nothing to refuse. The year named is
  // the one holding the most of them.
  const held = new Map<string, number>();
  const yearOfGroup = new Map(source.groups.map((group) => [group.id, group.academicYearId]));
  for (const student of source.students) {
    if (!student.isActive || student.studentGroupId === null) continue;
    const at = yearOfGroup.get(student.studentGroupId);
    if (at !== undefined && later.has(at)) held.set(at, (held.get(at) ?? 0) + 1);
  }
  if (held.size > 0) {
    const [holderId] = [...held.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    const pupils = [...held.values()].reduce((sum, count) => sum + count, 0);
    problems.push({
      code: 'YEAR_IS_SUPERSEDED',
      blocking: true,
      params: { year: year.name, successor: yearById.get(holderId)!.name, pupils },
    });
  }

  const sorted = [...writes.values()]
    .map((move) => ({ ...move, studentIds: [...move.studentIds].sort() }))
    .sort((a, b) =>
      `${a.fromGroupId}>${a.toGroupId ?? ''}` < `${b.fromGroupId}>${b.toGroupId ?? ''}` ? -1 : 1,
    );
  const active = source.years.find((candidate) => candidate.isActive) ?? null;
  const planHash = createHash('sha256')
    .update(
      JSON.stringify({
        yearId: year.id,
        handOver: !year.isActive,
        pairs: sorted.map((move) => [move.fromGroupId, move.toGroupId, move.studentIds]),
      }),
    )
    .digest('hex');

  return {
    year: { id: year.id, name: year.name, isActive: year.isActive },
    currentlyActive: active ? { id: active.id, name: active.name } : null,
    chain: chain.map((previous) => ({ id: previous.id, name: previous.name, endDate: previous.endDate })),
    moves: sorted
      .filter((move) => move.toGroupId !== null)
      .map((move) => ({
        fromGroupId: move.fromGroupId,
        fromGroupName: move.fromGroupName,
        toGroupId: move.toGroupId as string,
        toGroupName: move.toGroupName as string,
        count: move.studentIds.length,
      })),
    graduates: { count: graduates.length, studentIds: [...graduates].sort() },
    unplaced: {
      count: unplaced.length,
      studentIds: unplaced.map((pupil) => pupil.studentId).sort(),
      pupils: [...unplaced].sort((a, b) => (a.studentId < b.studentId ? -1 : 1)),
    },
    alreadyInYear,
    inLaterYear,
    otherOrNone,
    inactiveUntouched,
    problems,
    blocking: problems.some((problem) => problem.blocking),
    planHash,
    writes: sorted,
  };
}

/** Pupils whose home class the activation of the year would change. */
export function pendingMoves(plan: Pick<ActivationPlan, 'writes'>): number {
  return plan.writes.reduce((sum, move) => sum + move.studentIds.length, 0);
}
