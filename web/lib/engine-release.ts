/*
 * Släppta poster: what the card on tjänstefördelningen reads and sends.
 *
 * "Släppt för motorn" is a fact about ONE timplanspost (TeachingRequirementReleases on the gateway): Föreslå
 * bemanning never moves a teacher the school chose, and a released post is the school saying that it may. There is
 * one write path, by post id. A shortcut for "the whole subject in an årskurs" is this module expanding the posts of
 * that subject whose group has that gradeLevel into their ids; the gateway knows no subject, so there is no second
 * truth to disagree with the posts' own rows.
 *
 * Pure, and imported by nothing but the card: the page never reaches it.
 */

/** What a post needs here; every field is on the TeachingRequirement the page already holds. */
export interface ReleasePost {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
}

export interface ReleaseGroup {
  id: string;
  name: string;
  gradeLevel: number | null;
}

/** One post of a line, with what the card shows of it. */
export interface ReleaseLinePost {
  id: string;
  groupName: string;
  teacherId: string | null;
  /**
   * An active teacher leads it: the only kind of post a release means anything for. A post nobody teaches, or whose
   * teacher has left, is always open to the engine.
   */
  staffed: boolean;
  released: boolean;
}

/** The posts of one subject in one årskurs: a row of the card's table. */
export interface ReleaseLine {
  key: string;
  subjectId: string;
  subjectName: string;
  /** null: the group has no årskurs (or is not in the list); 0 is förskoleklass. */
  gradeLevel: number | null;
  posts: ReleaseLinePost[];
}

const sv = (a: string, b: string) => a.localeCompare(b, "sv", { numeric: true });

/**
 * The posts grouped by subject, then årskurs: subjects by name, årskurser ascending and "utan årskurs" last, a line's
 * posts by group name. `released` is the set of post ids the gateway lists as released.
 */
export function releaseLines({
  posts,
  groups,
  subjectName,
  activeStaff,
  released,
}: {
  posts: readonly ReleasePost[];
  groups: readonly ReleaseGroup[];
  subjectName: (subjectId: string) => string;
  /** Whether the teacher is still staff; a person the page cannot find counts as staff. */
  activeStaff: (userId: string) => boolean;
  released: ReadonlySet<string>;
}): ReleaseLine[] {
  const groupOf = new Map(groups.map((group) => [group.id, group]));
  const lines = new Map<string, ReleaseLine>();
  for (const post of posts) {
    const group = groupOf.get(post.studentGroupId);
    const gradeLevel = group?.gradeLevel ?? null;
    const key = `${post.subjectId}|${gradeLevel ?? "none"}`;
    let line = lines.get(key);
    if (!line) {
      line = { key, subjectId: post.subjectId, subjectName: subjectName(post.subjectId), gradeLevel, posts: [] };
      lines.set(key, line);
    }
    line.posts.push({
      id: post.id,
      groupName: group?.name ?? "—",
      teacherId: post.teacherId,
      staffed: post.teacherId !== null && activeStaff(post.teacherId),
      released: released.has(post.id),
    });
  }
  return [...lines.values()]
    .map((line) => ({ ...line, posts: [...line.posts].sort((a, b) => sv(a.groupName, b.groupName)) }))
    .sort(
      (a, b) =>
        sv(a.subjectName, b.subjectName) ||
        (a.gradeLevel ?? Number.MAX_SAFE_INTEGER) - (b.gradeLevel ?? Number.MAX_SAFE_INTEGER),
    );
}

/**
 * What "Släpp N bemannade" sends: the line's STAFFED posts that are not released yet. A post nobody teaches is always
 * open to the engine and needs no release; one already released is left out, so N is what the press changes.
 */
export function idsToRelease(line: Pick<ReleaseLine, "posts">): string[] {
  return line.posts.filter((post) => post.staffed && !post.released).map((post) => post.id);
}

/** What "Ta tillbaka alla" sends: every post of the line. Taking back a post that is not released changes nothing. */
export function idsToTakeBack(line: Pick<ReleaseLine, "posts">): string[] {
  return line.posts.map((post) => post.id);
}

/** How many of a line's posts are released, staffed or not (a release outlives the teacher it was made for). */
export const releasedIn = (line: Pick<ReleaseLine, "posts">): number => line.posts.filter((post) => post.released).length;

/** How many of a line's posts an active teacher leads. */
export const staffedIn = (line: Pick<ReleaseLine, "posts">): number => line.posts.filter((post) => post.staffed).length;

/** "2026-11-19" in the school's own time zone: the day a release was made, the same on every screen. */
export function formatReleaseDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(iso),
  );
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
