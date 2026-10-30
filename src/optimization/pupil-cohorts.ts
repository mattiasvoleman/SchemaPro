import { halvesByClass } from '../common/class-halves';
import type { AnonymousPupilGapCohort, AnonymousPupilGaps } from './interfaces/ai-engine-payload.interface';
import type { Rosters } from './room-eligibility';
import {
  keptByOf,
  leavesLesson,
  parseDerivedKey,
  replacedSubjectOf,
  replacementsOf,
} from '../common/replacing-groups';

/*
 * Elevernas håltimmar: who the engine is told sits whose lessons.
 *
 * The håltimmesrapport (web/lib/gaps.ts findIdleGaps) counts a hole per set
 * of pupils booked alike — a cohort — and the generator can only keep the
 * same holes down if it is told the same sets. This is that telling, pure,
 * over the rosters the payload is built from. No pupil id leaves: a cohort is
 * a count and the keys its pupils' lessons are filed under.
 *
 * A PUPIL'S DAY, by the report's rules and in the engine's pupil space:
 *
 *   groups     their home class, their teaching groups, and the half of
 *              their class they are placed in — or every half, when they are
 *              placed in none: they may end up in either, and the report
 *              counts them busy in both (class-halves.ts)
 *   keys       those groups, and every derived key "7A without SvA7"
 *              (replacing-groups.ts) whose group is theirs and none of whose
 *              replacing groups is: the requirements filed under it are the
 *              class's lessons a replacing group's members leave, and these
 *              pupils sit them
 *   locks      every locked lesson they sit, by the report's own rule: named
 *              on it, or one of their groups on it and not taken off it by a
 *              replacing group of theirs (leavesLesson). Named one by one
 *              rather than by keys, because a lock's keys hold everyone on
 *              it and may hold more — a pupil named on 7A's svenska keeps 7A
 *              on its keys, and SvA7's other pupils with it
 *
 * Two pupils with the same groups, keys, locks and class are one cohort.
 * src/common/__fixtures__/pupil-gaps-cases.json is the contract with the
 * report and the engine (pupil-cohorts.spec.ts).
 */

export interface PupilCohortGroup {
  id: string;
  kind?: string | null;
  halfOfId?: string | null;
  replacesSubjectId?: string | null;
}

export interface PupilCohortLock {
  /** The lock's real id: the caller turns it into the payload's own. */
  id: string;
  /** Its own group first, then every extra group. */
  groupIds: string[];
  subjectId: string;
  /** The pupils it names one by one. */
  pupilIds: readonly string[];
}

export interface PupilCohortInput {
  /** The pupils the week is about: each with the home class of the year. */
  homeOf: ReadonlyMap<string, string>;
  /** pupil -> every group of the year holding them (rosters.groupsByStudent). */
  groupsOf: ReadonlyMap<string, ReadonlySet<string>>;
  /** The year's groups: halves by halfOfId, replacing groups by replacesSubjectId. */
  groups: readonly PupilCohortGroup[];
  /** The derived keys the payload's requirements carry. */
  derivedKeys: Iterable<string>;
  /** The locked lessons forwarded to the engine. */
  locks: readonly PupilCohortLock[];
}

export interface PupilCohort {
  /** Sorted: the pupils' groups and the derived keys they sit. */
  groupIds: string[];
  /** Sorted: the locks they sit, by the caller's lock ids. */
  fixedLessonIds: string[];
  homeGroupId: string;
  pupils: number;
}

/** The cohorts of the pupils in `homeOf`, in a stable order. */
export function pupilCohortsOf(input: PupilCohortInput): PupilCohort[] {
  const halves = halvesByClass(input.groups.map((group) => ({ id: group.id, halfOfId: group.halfOfId ?? null })));
  const replaced = replacedSubjectOf(input.groups);
  const groupById = new Map(input.groups.map((group) => [group.id, group]));
  const derived = [...new Set(input.derivedKeys)].flatMap((key) => {
    const parsed = parseDerivedKey(key);
    return parsed ? [{ key, ...parsed }] : [];
  });
  const locks = input.locks.map((lock) => {
    const keptBy = keptByOf(groupById.get(lock.groupIds[0] ?? ''));
    return {
      lock,
      named: new Set(lock.pupilIds),
      scope: { subjectId: lock.subjectId, groupIds: lock.groupIds, ...(keptBy === undefined ? {} : { keptBy }) },
    };
  });

  const bySignature = new Map<string, PupilCohort>();
  for (const [pupil, home] of input.homeOf) {
    const groups = new Set(input.groupsOf.get(pupil) ?? []);
    groups.add(home);
    const ownHalves = halves.get(home) ?? [];
    if (!ownHalves.some((half) => groups.has(half))) for (const half of ownHalves) groups.add(half);

    const keys = new Set(groups);
    for (const key of derived) {
      if (groups.has(key.groupId) && !key.replacing.some((group) => groups.has(group))) keys.add(key.key);
    }
    const replacements = replacementsOf(groups, replaced);
    const sits = locks
      .filter(({ lock, named, scope }) =>
        named.has(pupil)
          ? true
          : lock.groupIds.some((group) => groups.has(group)) && !leavesLesson(replacements, scope, false, groups),
      )
      .map(({ lock }) => lock.id);

    const groupIds = [...keys].sort();
    const fixedLessonIds = [...new Set(sits)].sort();
    const signature = `${home}|${groupIds.join(',')}|${fixedLessonIds.join(',')}`;
    const cohort = bySignature.get(signature);
    if (cohort) cohort.pupils += 1;
    else bySignature.set(signature, { groupIds, fixedLessonIds, homeGroupId: home, pupils: 1 });
  }
  return [...bySignature.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, cohort]) => cohort);
}

/**
 * A locked lesson's minutes before and after it, for the pupils: the widest
 * of its groups' rows for its subject, as web/lib/conflicts.ts pupilBufferOf
 * reads them. Null when no row reaches it, or every row says 0.
 */
export function lockMarginOf(
  buffers: ReadonlyMap<string, { minutesBefore: number; minutesAfter: number }>,
  lock: { groupIds: readonly string[]; subjectId: string },
): { minutesBefore: number; minutesAfter: number } | null {
  let before = 0;
  let after = 0;
  for (const group of lock.groupIds) {
    const buffer = buffers.get(`${group}:${lock.subjectId}`);
    if (!buffer) continue;
    before = Math.max(before, buffer.minutesBefore);
    after = Math.max(after, buffer.minutesAfter);
  }
  return before > 0 || after > 0 ? { minutesBefore: before, minutesAfter: after } : null;
}

/**
 * The payload's pupilGaps, in anonymous ids: the cohorts of the year's home
 * classes' pupils, and the margins of the locks that have one. Null when the
 * week has no pupil, so the engine is never sent an empty list it refuses.
 *
 * `groupId` reads a group's or a derived key's anonymous id off the map the
 * rest of the payload was built through, `fixedId` a lock's; an id neither
 * knows is a group nothing in the payload reached. A pupil whose home
 * class is not one of the year's classes is not the year's pupil, and the
 * report has no class to count them under either.
 */
export function pupilGapsOf(input: {
  rosters: Pick<Rosters, 'homeMembers' | 'groupsByStudent'>;
  homeClassIds: readonly string[];
  groups: readonly PupilCohortGroup[];
  sentPupilKeys: Iterable<string>;
  locks: readonly PupilCohortLock[];
  buffers: readonly { studentGroupId: string; subjectId: string; minutesBefore: number; minutesAfter: number }[];
  groupId: (realId: string) => string | undefined;
  fixedId: (lessonId: string) => string | undefined;
}): AnonymousPupilGaps | null {
  const classes = new Set(input.homeClassIds);
  const homeOf = new Map<string, string>();
  for (const row of input.rosters.homeMembers) {
    if (row.studentGroupId && classes.has(row.studentGroupId)) homeOf.set(row.id, row.studentGroupId);
  }
  const cohorts = pupilCohortsOf({
    homeOf,
    groupsOf: input.rosters.groupsByStudent,
    groups: input.groups,
    derivedKeys: [...input.sentPupilKeys].filter((key) => parseDerivedKey(key) !== null),
    locks: input.locks,
  });

  // In the payload's ids, keeping only what the payload holds: two cohorts
  // that differ only in a group nothing reached are one cohort to the engine.
  const anonymous = new Map<string, AnonymousPupilGapCohort>();
  for (const cohort of cohorts) {
    const groupIds = [...new Set(cohort.groupIds.flatMap((id) => anonOf(input.groupId, id)))].sort();
    const fixedLessonIds = [...new Set(cohort.fixedLessonIds.flatMap((id) => anonOf(input.fixedId, id)))].sort();
    if (groupIds.length === 0) continue;
    const homeGroupId = input.groupId(cohort.homeGroupId);
    const signature = `${homeGroupId ?? ''}|${groupIds.join(',')}|${fixedLessonIds.join(',')}`;
    const same = anonymous.get(signature);
    if (same) same.pupils += cohort.pupils;
    else anonymous.set(signature, { groupIds, fixedLessonIds, ...(homeGroupId ? { homeGroupId } : {}), pupils: cohort.pupils });
  }
  if (anonymous.size === 0) return null;

  const buffers = new Map<string, { minutesBefore: number; minutesAfter: number }>();
  for (const row of input.buffers) {
    if (row.minutesBefore === 0 && row.minutesAfter === 0) continue;
    buffers.set(`${row.studentGroupId}:${row.subjectId}`, { minutesBefore: row.minutesBefore, minutesAfter: row.minutesAfter });
  }
  const fixedMargins = input.locks.flatMap((lock) => {
    const margin = lockMarginOf(buffers, lock);
    const fixedLessonId = input.fixedId(lock.id);
    return margin && fixedLessonId ? [{ fixedLessonId, ...margin }] : [];
  });
  return {
    cohorts: [...anonymous.values()],
    ...(fixedMargins.length > 0 ? { fixedMargins } : {}),
  };
}

function anonOf(lookup: (id: string) => string | undefined, id: string): string[] {
  const anon = lookup(id);
  return anon === undefined ? [] : [anon];
}
