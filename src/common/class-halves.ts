/**
 * Halvklasser: what a class's halves add to "these groups may not overlap".
 *
 * A half (StudentGroup.halfOfId, migration 20261113090000) is a teaching group
 * cut out of one class: 7A:1 and 7A:2, made by "Dela klassen". Every other
 * reader decides whether two groups' lessons may overlap by the pupils they
 * share (the engine's groupConflicts, the hand edit's findConflicts, the
 * publish check's year clashes, the web's lib/conflicts.ts). A half is planned
 * before its pupils are placed in it, and a group with no pupils shares
 * nothing: 7A's own lessons, its språkval and both halves' slöjd could all
 * land on one hour.
 *
 * So a half answers for the pupils it MAY hold, and the rule has three parts:
 *
 *   1. A half and its class never overlap, pupils or not: every pupil of the
 *      half is a pupil of the class (the trigger HALF_MEMBER_NOT_IN_CLASS), and
 *      a class whose pupils are not entered yet has them all the same.
 *   2. A pupil of the class placed in no half may end up in either: for every
 *      group such a pupil is in (the class itself, Ma7, a språkval group), each
 *      half pairs with it. Before anyone is placed a half therefore pairs with
 *      everything its class pairs with; once everyone is, it pairs with exactly
 *      what its own pupils are in, as any teaching group does.
 *   3. Two halves of one class NEVER pair: a pupil is in one of them (the
 *      unique index StudentGroupMembers_one_half_per_class), so 7A:1's slöjd
 *      and 7A:2's NO run at the same time — the rotation the halves exist for.
 *      Part 2 never pairs them, because it skips the class's own halves, and
 *      shared pupils never do, because no pupil is in both.
 *
 * Pairs between a half and the groups of the pupils PLACED in it are not made
 * here: those pupils are the half's members, and every caller already pairs a
 * group with the groups its members are in.
 *
 * Pure, over the caller's own maps, so the payload, the hand edit and the
 * publish check answer with one rule — and the web's copy in lib/conflicts.ts
 * is pinned to the same cases (class-halves.spec.ts mirrors its test).
 */

/** A group as the rule reads it: its id, and the class it is a half of. */
export interface GroupHalf {
  id: string;
  halfOfId: string | null;
}

/** pupil -> the groups holding them, from groupId -> pupils. */
export function groupsOfPupils(membersOf: ReadonlyMap<string, ReadonlySet<string>>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [group, pupils] of membersOf) {
    for (const pupil of pupils) {
      const groups = out.get(pupil);
      if (groups) groups.add(group);
      else out.set(pupil, new Set([group]));
    }
  }
  return out;
}

/** The halves of each class, among the groups given; classes with none are absent. */
export function halvesByClass(groups: Iterable<GroupHalf>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const group of groups) {
    if (!group.halfOfId) continue;
    out.set(group.halfOfId, [...(out.get(group.halfOfId) ?? []), group.id]);
  }
  return out;
}

/**
 * The pupils of a class placed in none of its halves: its members (home
 * pupils, as the caller read them) less everyone a half holds.
 */
export function unplacedPupils(
  classId: string,
  halves: readonly string[],
  membersOf: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const placed = new Set<string>();
  for (const half of halves) for (const pupil of membersOf.get(half) ?? []) placed.add(pupil);
  return [...(membersOf.get(classId) ?? [])].filter((pupil) => !placed.has(pupil));
}

/**
 * The pairs parts 1 and 2 add, each once and sorted within the pair. Over the
 * groups in `membersOf` and `groupsOf` only: a caller that read a narrower set
 * of groups gets the pairs among them.
 */
export function halfPairs(
  groups: Iterable<GroupHalf>,
  membersOf: ReadonlyMap<string, ReadonlySet<string>>,
  groupsOf: ReadonlyMap<string, ReadonlySet<string>>,
): [string, string][] {
  const keys = new Set<string>();
  const pairs: [string, string][] = [];
  const pair = (a: string, b: string) => {
    if (a === b) return;
    const [first, second] = a < b ? [a, b] : [b, a];
    const key = `${first}:${second}`;
    if (keys.has(key)) return;
    keys.add(key);
    pairs.push([first, second]);
  };
  for (const [classId, halves] of halvesByClass(groups)) {
    const own = new Set(halves);
    const unplaced = unplacedPupils(classId, halves, membersOf);
    for (const half of halves) {
      pair(classId, half);
      for (const pupil of unplaced) {
        for (const group of groupsOf.get(pupil) ?? []) {
          if (!own.has(group)) pair(group, half);
        }
      }
    }
  }
  return pairs;
}

/**
 * How many of the class's unplaced pupils a half is expected to take: what
 * fills it to an even share of the whole class, rounded up, and no more than
 * are unplaced. For the room a half needs before its pupils are placed — a
 * half of nobody needs one chair by the head count alone, and would be put in
 * a room too small for the fourteen it will hold. Filled towards the even
 * share rather than given an equal cut of the unplaced on top of what it has:
 * with 16 of 32 placed in 7A:1 and none in 7A:2, 7A:2 is the one that will
 * take the other 16, and 7A:1 sent as 24 would ask a slöjdsal for 16 to seat
 * 24 and be refused.
 */
export function unplacedShareOf(
  groups: Iterable<GroupHalf>,
  membersOf: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [classId, halves] of halvesByClass(groups)) {
    const unplaced = unplacedPupils(classId, halves, membersOf).length;
    const placedIn = (half: string) => membersOf.get(half)?.size ?? 0;
    const even = Math.ceil((unplaced + halves.reduce((sum, half) => sum + placedIn(half), 0)) / halves.length);
    for (const half of halves) out.set(half, Math.min(unplaced, Math.max(0, even - placedIn(half))));
  }
  return out;
}
