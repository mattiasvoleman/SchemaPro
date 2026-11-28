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
}

/** What of a lesson that stands where it stood has changed. */
export type Aspect = "teacher" | "coTeacher" | "room" | "weeks" | "groups" | "pupils";

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
const wholeOf = (lesson: DiffLesson): string => `${whatOf(lesson)}#${lesson.roomId ?? ""}#${placeOf(lesson)}`;

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

/** Pairs the lessons of the two sides that agree on `key`, in order, and gives back what is left on each. */
function pairBy<L extends DiffLesson>(left: L[], right: L[], key: (lesson: L) => string, make: (from: L, to: L) => DiffEntry<L>): [DiffEntry<L>[], L[], L[]] {
  const buckets = new Map<string, L[]>();
  for (const lesson of right) buckets.set(key(lesson), [...(buckets.get(key(lesson)) ?? []), lesson]);
  const pairs: DiffEntry<L>[] = [];
  const restLeft: L[] = [];
  const usedRight = new Set<L>();
  for (const from of left) {
    const to = buckets.get(key(from))?.shift();
    if (to) {
      pairs.push(make(from, to));
      usedRight.add(to);
    } else {
      restLeft.push(from);
    }
  }
  return [pairs, restLeft, right.filter((lesson) => !usedRight.has(lesson))];
}

const aspectsOf = (from: DiffLesson, to: DiffLesson): Aspect[] => {
  const found: Aspect[] = [];
  if ((from.teacherId ?? "") !== (to.teacherId ?? "")) found.push("teacher");
  if ((from.coTeacherId ?? "") !== (to.coTeacherId ?? "")) found.push("coTeacher");
  if ((from.roomId ?? "") !== (to.roomId ?? "")) found.push("room");
  if (weeksOf(from) !== weeksOf(to)) found.push("weeks");
  if (sorted(from.extraGroupIds) !== sorted(to.extraGroupIds)) found.push("groups");
  if (sorted(from.studentIds) !== sorted(to.studentIds)) found.push("pupils");
  return found;
};

/**
 * What `to` says that `from` does not. Lessons that stand the same on both sides are not in it. Then, in this order, and each lesson in one entry only:
 *   1. the same lesson (what it is) at another place: `moved` (and `room` when its room is another too), or in the same place with only another room: `changed`;
 *   2. the same class and subject in the same place with something else changed: `changed`, with what.
 * The rest is `removed` (only in `from`) and `added` (only in `to`).
 */
export function diffLessons<L extends DiffLesson>(from: readonly L[], to: readonly L[]): DiffEntry<L>[] {
  const onlyFrom = inOrder(unmatched([...from], to));
  const onlyTo = inOrder(unmatched([...to], from));
  const [sameLesson, leftFrom, leftTo] = pairBy(onlyFrom, onlyTo, whatOf, (a, b) =>
    placeOf(a) !== placeOf(b) ? { kind: "moved", from: a, to: b, room: (a.roomId ?? "") !== (b.roomId ?? "") } : { kind: "changed", from: a, to: b, aspects: aspectsOf(a, b) },
  );
  const [inPlace, removed, added] = pairBy(leftFrom, leftTo, (lesson) => `${lesson.subjectId}#${lesson.studentGroupId}#${placeOf(lesson)}`, (a, b) => ({ kind: "changed", from: a, to: b, aspects: aspectsOf(a, b) }));
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
