import type { LessonRecurrence } from "@/lib/types";

/*
 * JÄMFÖRELSEN AV TVÅ SCHEMAN (E9): what one grundschema says that another does not, with a lesson that has moved shown as one that has moved.
 *
 * A version is a snapshot with no lesson ids (a restore lays every lesson again under a new one), so "the same lesson" is read off what a lesson IS:
 * its subject, its class, who teaches it, which weeks it runs, who else is in it. Two lessons that agree on all of that and stand at another day or clock
 * are one lesson that moved, and the diff says so in one line; a lesson that stands where it stood but has another teacher or room is one that changed.
 * What is left on either side is a lesson that is not on the other: added or removed. Pure, so that the dialog (lazy) and its tests read the same rule.
 */

/** What either side of a comparison says of a lesson: a snapshot (VersionLesson) and the grid on screen (MasterLesson) both have it. */
export interface DiffLesson {
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId?: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  /** On the tray: a lesson that occupies nothing, whose day and clock are only a memory. Absent is false (a snapshot from before the tray). */
  isParked?: boolean;
  recurrence?: LessonRecurrence;
  startDate?: string | null;
  endDate?: string | null;
  extraGroupIds?: string[];
  studentIds?: string[];
  /** A restore writes the lock and the exemptions too: a lesson that stands the same but is locked on one side only is not the same on both. Absent is not locked and none. */
  isLocked?: boolean;
  exemptFrom?: readonly string[];
}

/** What of a lesson that stands where it stood has changed. */
export type Aspect = "teacher" | "coTeacher" | "room" | "weeks" | "groups" | "pupils" | "locked" | "exempt";

export type DiffEntry<L extends DiffLesson = DiffLesson> =
  /** The same lesson at another day or clock, or on the tray or off it; `room` says whether the room is another one too. */
  | { kind: "moved"; from: L; to: L; room: boolean }
  /** The same lesson in the same place, with another teacher, room, weeks, class or pupils. */
  | { kind: "changed"; from: L; to: L; aspects: Aspect[] }
  | { kind: "added"; to: L }
  | { kind: "removed"; from: L };

/** `HH:MM`, whether the clock came with seconds (PostgREST) or without. */
const clock = (time: string): string => time.slice(0, 5);

/** The first ten characters, and null for an absent or empty value: the way a restore reads a date. */
const day = (value: string | null | undefined): string => (value ? value.slice(0, 10) : "");

const sorted = (ids: readonly string[] | undefined): string => [...(ids ?? [])].sort().join(",");

/** Where a lesson stands. On the tray the day and the clock are a memory and not a place. */
export const placeOf = (lesson: DiffLesson): string => (lesson.isParked ? "tray" : `${lesson.dayOfWeek}|${clock(lesson.startTime)}|${clock(lesson.endTime)}`);

/** Which weeks it runs: absent is every week, as a restore reads it. */
const weeksOf = (lesson: DiffLesson): string => `${lesson.recurrence ?? "ALL_WEEKS"}|${day(lesson.startDate)}|${day(lesson.endDate)}`;

/** What the lesson is, whatever room and place it has. */
const whatOf = (lesson: DiffLesson): string =>
  [lesson.subjectId, lesson.studentGroupId, lesson.teacherId ?? "", lesson.coTeacherId ?? "", weeksOf(lesson), sorted(lesson.extraGroupIds), sorted(lesson.studentIds)].join("#");

/** Everything a restore writes. */
const wholeOf = (lesson: DiffLesson): string => `${whatOf(lesson)}#${lesson.roomId ?? ""}#${placeOf(lesson)}#${lesson.isLocked ? "locked" : ""}#${sorted(lesson.exemptFrom)}`;

/** The lessons' own order, so that two runs over the same schedules pair the same lessons: by place, then by what they are. */
const inOrder = <L extends DiffLesson>(lessons: L[]): L[] => [...lessons].sort((a, b) => (placeOf(a) + whatOf(a)).localeCompare(placeOf(b) + whatOf(b)));

/** How many lessons stand in each exact way. */
function counted(lessons: readonly DiffLesson[]): Map<string, number> {
  const stands = new Map<string, number>();
  for (const lesson of lessons) stands.set(wholeOf(lesson), (stands.get(wholeOf(lesson)) ?? 0) + 1);
  return stands;
}

/** The lessons of `side` that the other side has no identical lesson for, counted: two lessons that are alike are two, and one of them gone is one removed. */
function unmatched<L extends DiffLesson>(side: L[], other: readonly DiffLesson[]): L[] {
  const left = counted(other);
  return side.filter((lesson) => {
    const key = wholeOf(lesson);
    const n = left.get(key) ?? 0;
    if (n > 0) left.set(key, n - 1);
    return n === 0;
  });
}

/**
 * Which lesson of `right` each lesson of `left` is, as many pairs as there can be. Two lessons may be paired when they are the same lesson at another place
 * (`whatOf`) or stand in the same place as the same subject and class (`placeOf`, something else changed). A greedy pass over one kind of pair and then the
 * other pairs lessons that a better choice would have kept apart: with Mon and Tue of one lesson on one side, and the Monday one with another teacher and a
 * Wednesday one on the other, taking "Monday to Wednesday" first leaves "Tuesday removed" and "Monday with the new teacher added", a move that did not
 * happen and a line too many. So a lesson that finds its partner taken asks the holder to take another (an augmenting path, per subject and class, where a
 * group is a handful of lessons), and the pairs that come out are as many as the lessons allow. Each lesson prefers, in this order: the same lesson in the
 * same place (another room), the same lesson elsewhere (moved), the same place with something else changed; and a free partner before one that is taken.
 */
function pairUp<L extends DiffLesson>(left: L[], right: L[]): Map<L, L> {
  // What a lesson is and where it stands, read once: a school with one subject in one class a hundred times over asks for them a million times otherwise.
  const keys = new Map<L, { what: string; place: string; group: string }>();
  for (const lesson of [...left, ...right]) keys.set(lesson, { what: whatOf(lesson), place: placeOf(lesson), group: `${lesson.subjectId}#${lesson.studentGroupId}` });
  const byWhat = new Map<string, L[]>();
  const byPlace = new Map<string, L[]>();
  for (const lesson of right) {
    const key = keys.get(lesson)!;
    byWhat.set(key.what, [...(byWhat.get(key.what) ?? []), lesson]);
    byPlace.set(`${key.group}|${key.place}`, [...(byPlace.get(`${key.group}|${key.place}`) ?? []), lesson]);
  }
  const partnerOf = new Map<L, L>();
  const holderOf = new Map<L, L>();
  const candidates = (lesson: L): L[] => {
    const key = keys.get(lesson)!;
    const same = byWhat.get(key.what) ?? [];
    return [
      ...same.filter((other) => keys.get(other)!.place === key.place),
      ...same.filter((other) => keys.get(other)!.place !== key.place),
      ...(byPlace.get(`${key.group}|${key.place}`) ?? []).filter((other) => keys.get(other)!.what !== key.what),
    ];
  };
  const hold = (lesson: L, other: L) => {
    holderOf.set(other, lesson);
    partnerOf.set(lesson, other);
  };
  const find = (lesson: L, tried: Set<L>): boolean => {
    const options = candidates(lesson);
    const free = options.find((other) => !holderOf.has(other));
    if (free) {
      hold(lesson, free);
      return true;
    }
    for (const other of options) {
      if (tried.has(other)) continue;
      tried.add(other);
      if (find(holderOf.get(other)!, tried)) {
        hold(lesson, other);
        return true;
      }
    }
    return false;
  };
  for (const lesson of left) find(lesson, new Set());
  return partnerOf;
}

const aspectsOf = (from: DiffLesson, to: DiffLesson): Aspect[] => {
  const found: Aspect[] = [];
  if ((from.teacherId ?? "") !== (to.teacherId ?? "")) found.push("teacher");
  if ((from.coTeacherId ?? "") !== (to.coTeacherId ?? "")) found.push("coTeacher");
  if ((from.roomId ?? "") !== (to.roomId ?? "")) found.push("room");
  if (weeksOf(from) !== weeksOf(to)) found.push("weeks");
  if (sorted(from.extraGroupIds) !== sorted(to.extraGroupIds)) found.push("groups");
  if (sorted(from.studentIds) !== sorted(to.studentIds)) found.push("pupils");
  if (Boolean(from.isLocked) !== Boolean(to.isLocked)) found.push("locked");
  if (sorted(from.exemptFrom) !== sorted(to.exemptFrom)) found.push("exempt");
  return found;
};

/**
 * What `to` says that `from` does not. Lessons that stand the same on both sides are not in it. The rest are paired as far as they can be (`pairUp`: the most
 * pairs there can be, and a lesson is in one entry only), and a pair is
 *   1. the same lesson (what it is) at another place: `moved` (and `room` when its room is another too), or in the same place with only another room: `changed`;
 *   2. the same class and subject in the same place with something else changed: `changed`, with what.
 * What is not paired is `removed` (only in `from`) and `added` (only in `to`).
 */
export function diffLessons<L extends DiffLesson>(from: readonly L[], to: readonly L[]): DiffEntry<L>[] {
  const onlyFrom = inOrder(unmatched([...from], to));
  const onlyTo = inOrder(unmatched([...to], from));
  const partnerOf = pairUp(onlyFrom, onlyTo);
  const sameLesson: DiffEntry<L>[] = [];
  const inPlace: DiffEntry<L>[] = [];
  const paired = new Set<L>();
  for (const a of onlyFrom) {
    const b = partnerOf.get(a);
    if (!b) continue;
    paired.add(b);
    if (whatOf(a) !== whatOf(b)) inPlace.push({ kind: "changed", from: a, to: b, aspects: aspectsOf(a, b) });
    else sameLesson.push(placeOf(a) !== placeOf(b) ? { kind: "moved", from: a, to: b, room: (a.roomId ?? "") !== (b.roomId ?? "") } : { kind: "changed", from: a, to: b, aspects: aspectsOf(a, b) });
  }
  const removed = onlyFrom.filter((lesson) => !partnerOf.has(lesson));
  const added = onlyTo.filter((lesson) => !paired.has(lesson));
  return [...sameLesson, ...inPlace, ...removed.map((lesson): DiffEntry<L> => ({ kind: "removed", from: lesson })), ...added.map((lesson): DiffEntry<L> => ({ kind: "added", to: lesson }))];
}

/** How many entries of each kind. */
export function countsOf(entries: readonly DiffEntry[]): Record<DiffEntry["kind"], number> {
  const counts = { moved: 0, changed: 0, added: 0, removed: 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  return counts;
}

/** The class an entry is about: the lesson's own, on whichever side it stands. */
export const classOf = (entry: DiffEntry): string => (entry.kind === "removed" ? entry.from : entry.to).studentGroupId;

/** The order the kinds are read in within a class: what moved, what changed, what came, what went. */
export const KIND_ORDER: ReadonlyArray<DiffEntry["kind"]> = ["moved", "changed", "added", "removed"];
