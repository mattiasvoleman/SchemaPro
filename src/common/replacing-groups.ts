/**
 * Ersättande grupper: who a replacing group takes off a lesson.
 *
 * A replacing group (StudentGroup.replacesSubjectId, migration
 * 20261211090000) is a teaching group whose members leave their other lessons
 * in one subject: SvA7 replaces Svenska, so a pupil in SvA7 goes to SvA7's
 * lessons instead of 7A's svenska, and 7A's svenska does not list them.
 *
 * THE RULE. A pupil is not on a lesson when
 *
 *   - they are not named on it;
 *   - they are a member of a replacing group for the lesson's subject, in the
 *     läsår of the lesson's own group;
 *   - none of their replacing groups for that subject is one of the lesson's
 *     groups (its own or an extra one);
 *   - and the lesson's own group is not a teaching group they are placed in
 *     by name (its `keptBy`): a fördjupning, a lässtöd, a nivågrupp — any
 *     teaching group but a half.
 *
 * Otherwise the reader's own rule decides (home class, teaching groups, named
 * pupils).
 *
 *  - An extra group (CalendarLessonGroups, #193) puts its pupils ON a lesson;
 *    a replacing group takes its pupils OFF the class's lessons in its
 *    subject, however they reach them — the home class, a half. The two
 *    combine: SvA7 added to 7B's svenska puts its pupils on that lesson,
 *    because SvA7 is then one of the lesson's groups. A pupil in two groups
 *    replacing Svenska (SvA7 and SvA7 stöd) goes to the lessons of either.
 *  - A teaching group the pupil is placed in keeps them: placing an SvA pupil
 *    in Svenska fördjupning says they go there. A half is the class's, and
 *    places nobody by choice, so it does not.
 *  - A named pupil always stays: the explicit beats the derived.
 *  - No dates within a läsår: StudentGroupMembers carries none. But the
 *    läsår holds: the rollover keeps last year's memberships as history, and
 *    last year's SvA7 still replaces Svenska, so a pupil who left SvA would
 *    otherwise leave this year's svenska too. A reader whose groups all
 *    belong to one läsår (the engine's payload, the publish check, the
 *    timplan) reads only that year's groups; one that reads across years
 *    passes the groups' years (`yearOf`) and each lesson's
 *    (`ReplacedScope.academicYearId`), and the rule compares them.
 *
 * Two levels, one rule:
 *
 *  - PER PUPIL, leavesLesson: the lesson roster (calendar/lesson-roster.ts),
 *    the family's week, the timplan's pupil lines, the hand edit's clash
 *    check.
 *  - PER GROUP, pupilKeyOf + replacementPairs: every reader that keeps groups
 *    apart by pairs that share a pupil (the engine's groupConflicts, the
 *    publish check's year clashes, the web's lib/conflicts.ts). A group's
 *    lessons in a replaced subject answer for a DERIVED key — "7A without
 *    SvA7" — that pairs with everything 7A pairs with but SvA7, so SvA7's
 *    lessons may sit beside 7A's svenska and nowhere else in 7A's week. The
 *    trick is Halvklasser's (common/class-halves.ts): a group answers for the
 *    pupils it holds.
 *
 * A school with no replacing group gets every answer it got before: no
 * pupil leaves a lesson, every key is the group itself, and no pair is added.
 *
 * Pure, so the gateway and the web answer with one rule; web/lib/
 * replacing-groups.ts is a copy, and both replay
 * src/common/__fixtures__/replacing-groups-cases.json.
 */

/** One replacing group a pupil is in, the subject it replaces, and its läsår when known. */
export interface Replacement {
  groupId: string;
  subjectId: string;
  academicYearId?: string;
}

/** A group as the rule reads it. */
export interface ReplacingGroupRow {
  id: string;
  replacesSubjectId?: string | null;
  academicYearId?: string | null;
}

/** A lesson (or a timplanspost, or a credit) as the rule reads it. */
export interface ReplacedScope {
  subjectId: string;
  /** Its own group and every extra group. */
  groupIds: readonly string[];
  /**
   * Its own group, when that is a teaching group pupils are placed in by name
   * and not a half (keptByOf): its members keep the lesson whatever they
   * replace. Absent for a class or a half.
   */
  keptBy?: string;
  /**
   * The läsår of its own group, for a reader whose groups span years; a
   * replacing group of another läsår takes nobody off it. Absent: every
   * replacing group the reader passes is of the lesson's year.
   */
  academicYearId?: string;
}

/** A group as keptByOf reads it. */
export interface KeptByRow {
  id: string;
  kind?: string | null;
  halfOfId?: string | null;
}

/**
 * A lesson's `keptBy`: its own group when that is a teaching group and not a
 * half. Undefined for a class, a half, or a group the reader cannot see.
 */
export function keptByOf(own: KeptByRow | undefined | null): string | undefined {
  return own && own.kind === 'TEACHING_GROUP' && !own.halfOfId ? own.id : undefined;
}

/** groupId -> its läsår, for the groups that carry one. */
export function yearsOf(groups: Iterable<ReplacingGroupRow>): Map<string, string> {
  const out = new Map<string, string>();
  for (const group of groups) if (group.academicYearId) out.set(group.id, group.academicYearId);
  return out;
}

/** Is a replacing group of `groupId` in the scope's läsår (or is either unknown)? */
function sameYear(groupId: string, scope: ReplacedScope, yearOf?: ReadonlyMap<string, string>): boolean {
  if (scope.academicYearId === undefined || !yearOf) return true;
  const year = yearOf.get(groupId);
  return year === undefined || year === scope.academicYearId;
}

/** groupId -> the subject it replaces, for the groups that replace one. */
export function replacedSubjectOf(groups: Iterable<ReplacingGroupRow>): Map<string, string> {
  const out = new Map<string, string>();
  for (const group of groups) if (group.replacesSubjectId) out.set(group.id, group.replacesSubjectId);
  return out;
}

/** subjectId -> the groups replacing it, each list sorted. */
export function replacingBySubject(replaced: ReadonlyMap<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [groupId, subjectId] of replaced) {
    const list = out.get(subjectId);
    if (list) list.push(groupId);
    else out.set(subjectId, [groupId]);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/** A pupil's replacements: those of their groups that replace a subject, with their läsår when `yearOf` knows it. */
export function replacementsOf(
  groupIds: Iterable<string>,
  replaced: ReadonlyMap<string, string>,
  yearOf?: ReadonlyMap<string, string>,
): Replacement[] {
  const out: Replacement[] = [];
  for (const groupId of new Set(groupIds)) {
    const subjectId = replaced.get(groupId);
    if (!subjectId) continue;
    const academicYearId = yearOf?.get(groupId);
    out.push(academicYearId ? { groupId, subjectId, academicYearId } : { groupId, subjectId });
  }
  return out;
}

/**
 * THE RULE: does a pupil with these replacements leave this lesson? `named`
 * says the pupil is named on it, which keeps them on; `pupilGroups` are the
 * pupil's groups, of which the lesson's `keptBy` keeps them on too.
 */
export function leavesLesson(
  replacements: readonly Replacement[],
  scope: ReplacedScope,
  named = false,
  pupilGroups: Iterable<string> = [],
): boolean {
  if (named || replacements.length === 0) return false;
  const forSubject = replacements.filter(
    (replacement) =>
      replacement.subjectId === scope.subjectId &&
      (replacement.academicYearId === undefined ||
        scope.academicYearId === undefined ||
        replacement.academicYearId === scope.academicYearId),
  );
  if (forSubject.length === 0) return false;
  if (forSubject.some((replacement) => scope.groupIds.includes(replacement.groupId))) return false;
  if (scope.keptBy !== undefined && [...pupilGroups].includes(scope.keptBy)) return false;
  return true;
}

/**
 * The pupils of `roster` the rule takes off the lesson: members of a group
 * replacing its subject, none of whose groups replacing it is on the lesson,
 * who are neither in its `keptBy` nor named on it. `membersOf` needs the
 * groups replacing the subject and the scope's `keptBy`.
 */
export function replacedPupils(
  roster: Iterable<string>,
  scope: ReplacedScope,
  named: ReadonlySet<string>,
  bySubject: ReadonlyMap<string, readonly string[]>,
  membersOf: ReadonlyMap<string, ReadonlySet<string>>,
  yearOf?: ReadonlyMap<string, string>,
): Set<string> {
  const out = new Set<string>();
  const forSubject = (bySubject.get(scope.subjectId) ?? []).filter((groupId) => sameYear(groupId, scope, yearOf));
  const off = forSubject.filter((groupId) => !scope.groupIds.includes(groupId));
  if (off.length === 0) return out;
  const on = forSubject.filter((groupId) => scope.groupIds.includes(groupId));
  const kept = scope.keptBy === undefined ? undefined : membersOf.get(scope.keptBy);
  for (const pupil of roster) {
    if (named.has(pupil) || kept?.has(pupil)) continue;
    if (on.some((groupId) => membersOf.get(groupId)?.has(pupil))) continue;
    if (off.some((groupId) => membersOf.get(groupId)?.has(pupil))) out.add(pupil);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per group: derived keys and the pairs they add.
// ---------------------------------------------------------------------------

/** Between a derived key's group and its replacing groups; group ids are UUIDs, which never hold it. */
const SEPARATOR = '~';

/** The key "groupId without these replacing groups". */
export function derivedKey(groupId: string, replacing: readonly string[]): string {
  return [groupId, ...[...replacing].sort()].join(SEPARATOR);
}

/** A derived key's group and replacing groups; null for a plain group id. */
export function parseDerivedKey(key: string): { groupId: string; replacing: string[] } | null {
  if (!key.includes(SEPARATOR)) return null;
  const [groupId, ...replacing] = key.split(SEPARATOR);
  return { groupId: groupId!, replacing };
}

/** The group a key stands for: itself, or a derived key's group. */
export function baseOf(key: string): string {
  return parseDerivedKey(key)?.groupId ?? key;
}

/**
 * The key one of a lesson's groups answers for: the group itself, or — when
 * groups replacing the lesson's subject, not on the lesson, share pupils with
 * it — the derived key naming them. `shares(a, b)`: the reader's own relation
 * (do these two groups share a pupil).
 *
 * A group whose members all keep the lesson answers for itself: the lesson's
 * `keptBy`, and a group replacing its subject (SvA7 on 7B's svenska; SvA7 on
 * its own lesson, which a pupil also in SvA7 stöd keeps). A pupil a derived
 * key leaves out but who keeps the lesson through such a group is in that
 * group's key, so the lesson's keys together still hold everyone on it.
 *
 * `namedIn`: the replacing groups of the pupils NAMED on the lesson. A named
 * pupil stays on it, so their replacing group is not left out: 7A's svenska
 * naming Alva of SvA7 shares Alva with SvA7's lessons, and answers for 7A.
 */
export function pupilKeyOf(
  groupId: string,
  scope: ReplacedScope,
  bySubject: ReadonlyMap<string, readonly string[]>,
  shares: (a: string, b: string) => boolean,
  namedIn: readonly string[] = [],
  yearOf?: ReadonlyMap<string, string>,
): string {
  if (groupId === scope.keptBy) return groupId;
  const forSubject = bySubject.get(scope.subjectId) ?? [];
  if (forSubject.includes(groupId) && sameYear(groupId, scope, yearOf)) return groupId;
  const replacing = forSubject.filter(
    (other) =>
      other !== groupId &&
      !scope.groupIds.includes(other) &&
      !namedIn.includes(other) &&
      sameYear(other, scope, yearOf) &&
      shares(groupId, other),
  );
  return replacing.length === 0 ? groupId : derivedKey(groupId, replacing);
}

/** The keys a lesson's groups answer for, in its groups' order. */
export function pupilKeysOf(
  scope: ReplacedScope,
  bySubject: ReadonlyMap<string, readonly string[]>,
  shares: (a: string, b: string) => boolean,
  namedIn: readonly string[] = [],
  yearOf?: ReadonlyMap<string, string>,
): string[] {
  return scope.groupIds.map((groupId) => pupilKeyOf(groupId, scope, bySubject, shares, namedIn, yearOf));
}

/** The replacing groups the named pupils of a lesson are in: pupilKeyOf's `namedIn`. */
export function replacingGroupsOfNamed(
  named: Iterable<string>,
  groupsOfPupil: (pupil: string) => Iterable<string>,
  replaced: ReadonlyMap<string, string>,
): string[] {
  const out = new Set<string>();
  for (const pupil of named) for (const groupId of groupsOfPupil(pupil)) if (replaced.has(groupId)) out.add(groupId);
  return [...out].sort();
}

/**
 * The pairs derived keys add to the reader's pairwise relation, each once,
 * sorted within the pair. A derived key D = (g without Rs) pairs with
 *
 *   1. g itself, pupils or not: D's pupils are g's (Halvklasser's structural
 *      pair; it keeps 7A's svenska off 7A's other hours even before 7A's
 *      pupils are entered);
 *   2. every partner of g except the groups in Rs: whoever shares a pupil
 *      with g may share one with D — kept even when every pupil they share
 *      is in Rs, which only ever keeps lessons apart that could have met;
 *   3. every other derived key of g, or of a partner of g, unless one side
 *      excludes the other's group.
 *
 * And never with a group of Rs: D's pupils are none of theirs. That missing
 * pair is the whole feature.
 */
export function replacementPairs(
  keys: Iterable<string>,
  partnersOf: (groupId: string) => Iterable<string>,
): [string, string][] {
  const derived = [...new Set(keys)]
    .map((key) => ({ key, parsed: parseDerivedKey(key) }))
    .filter((entry): entry is { key: string; parsed: { groupId: string; replacing: string[] } } => entry.parsed !== null)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  const pair = (a: string, b: string) => {
    if (a === b) return;
    const [first, second] = a < b ? [a, b] : [b, a];
    const id = `${first} ${second}`;
    if (seen.has(id)) return;
    seen.add(id);
    pairs.push([first, second]);
  };
  const reach = new Map<string, Set<string>>();
  const reachOf = (groupId: string) => {
    let set = reach.get(groupId);
    if (!set) {
      set = new Set([groupId, ...partnersOf(groupId)]);
      set.delete(groupId);
      reach.set(groupId, set);
    }
    return set;
  };
  for (const { key, parsed } of derived) {
    const excluded = new Set(parsed.replacing);
    pair(key, parsed.groupId);
    for (const partner of reachOf(parsed.groupId)) if (!excluded.has(partner)) pair(key, partner);
    for (const other of derived) {
      if (other.key === key) continue;
      const near = other.parsed.groupId === parsed.groupId || reachOf(parsed.groupId).has(other.parsed.groupId);
      if (!near) continue;
      if (excluded.has(other.parsed.groupId) || other.parsed.replacing.includes(parsed.groupId)) continue;
      pair(key, other.key);
    }
  }
  return pairs;
}

/**
 * Do two keys share a pupil? replacementPairs' rule asked of one pair, for a
 * reader that compares lessons two at a time (the board, the publish check)
 * and never lists its keys: the same key, the same group, the reader's own
 * relation between their groups — unless one key leaves the other's group
 * out. Over plain group ids (no replacing group) it is the reader's own
 * "same group or sharing" test, unchanged.
 */
export function keysShare(a: string, b: string, shares: (a: string, b: string) => boolean): boolean {
  if (a === b) return true;
  const left = parseDerivedKey(a);
  const right = parseDerivedKey(b);
  const groupA = left?.groupId ?? a;
  const groupB = right?.groupId ?? b;
  if (left?.replacing.includes(groupB) || right?.replacing.includes(groupA)) return false;
  if (!left && !right) return shares(groupA, groupB);
  return groupA === groupB || shares(groupA, groupB);
}
