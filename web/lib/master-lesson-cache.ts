import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { MasterLesson } from "@/lib/types";
import { createClient } from "@/utils/supabase/client";

/**
 * The year's lesson lists in the query cache, patched one lesson at a time.
 *
 * A write used to leave the grid as it was until the whole year had been read
 * again (800 lessons with their groups and pupils, a few hundred milliseconds
 * on a good day), and the card stood on its old square all that while. The
 * answer to a write is the lesson as the gateway now holds it, so the list can
 * be given that, and a colleague's change can be given the same way
 * (use-timetable-realtime.ts).
 *
 * Only ["masterLessons", <year>] is a list of lessons. Other keys under the same
 * root hold other things (["masterLessons", <year>, "origin"] is a map of where
 * each lesson came from), and a patch must never touch them.
 */

/** The columns of a lesson a write can change: what a patch may carry onto a row. */
const FIELDS = [
  "dayOfWeek",
  "startTime",
  "endTime",
  "roomId",
  "teacherId",
  "coTeacherId",
  "isLocked",
  "isParked",
  "recurrence",
  "startDate",
  "endDate",
  "extraGroupIds",
  "studentIds",
] as const satisfies ReadonlyArray<keyof MasterLesson>;

export type LessonPatch = Partial<Pick<MasterLesson, (typeof FIELDS)[number]>>;

/** A lesson as a list held it, kept so that a refused write can put it back. */
export type Remembered = Array<{
  key: QueryKey;
  id: string;
  row: MasterLesson | undefined;
  /** The row the write laid in its place, when it laid one: the lesson is put back only while this is still what the list holds. */
  wrote?: MasterLesson;
}>;

function yearLists(queryClient: QueryClient): Array<[QueryKey, MasterLesson[]]> {
  return queryClient
    .getQueriesData<MasterLesson[]>({ queryKey: ["masterLessons"] })
    .filter((entry): entry is [QueryKey, MasterLesson[]] => entry[0].length === 2 && Array.isArray(entry[1]));
}

/** The patch's own fields only: an answer carries the whole lesson, and a body carries more than the lesson. */
export function lessonFieldsOf(source: object | null | undefined): LessonPatch {
  const found: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const value = (source as Record<string, unknown> | null | undefined)?.[field];
    if (value !== undefined) found[field] = value;
  }
  return found as LessonPatch;
}

/**
 * A time the way the list writes it. PostgREST gives "08:00:00" and the gateway
 * answers "08:00"; a list with both would make two lessons at the same hour
 * differ as strings, which is what the block cards group by.
 */
function inFormatOf(existing: string, time: string): string {
  return existing.length > 5 && time.length === 5 ? `${time}${existing.slice(5)}` : time;
}

function patched(row: MasterLesson, fields: LessonPatch): MasterLesson {
  const next: MasterLesson = { ...row, ...fields };
  if (fields.startTime !== undefined) next.startTime = inFormatOf(row.startTime, fields.startTime);
  if (fields.endTime !== undefined) next.endTime = inFormatOf(row.endTime, fields.endTime);
  return next;
}

/** Whether a read of a year's list is on its way. */
function yearIsBeingRead(queryClient: QueryClient): boolean {
  return queryClient.isFetching({ queryKey: ["masterLessons"], predicate: (query) => query.queryKey.length === 2 }) > 0;
}

/**
 * Stops the read of the year that is on its way, so that it cannot land on top of what a write has just put on the card:
 * it began before the write and would show the lesson where it was. Says whether there was one, because then the write
 * must be followed by a read (what that read would have brought is not lost).
 */
export async function holdReadsOfTheYear(queryClient: QueryClient): Promise<boolean> {
  const reading = yearIsBeingRead(queryClient);
  if (reading) {
    await queryClient.cancelQueries({ queryKey: ["masterLessons"], predicate: (query) => query.queryKey.length === 2 });
  }
  return reading;
}

/** Puts `fields` on the lesson in every list that holds it. Returns what each list held. */
export function patchLesson(queryClient: QueryClient, id: string, fields: LessonPatch): Remembered {
  const remembered: Remembered = [];
  for (const [key, lessons] of yearLists(queryClient)) {
    const at = lessons.findIndex((lesson) => lesson.id === id);
    if (at === -1) continue;
    const row = lessons[at]!;
    const next = lessons.slice();
    next[at] = patched(row, fields);
    queryClient.setQueryData(key, next);
    // What the list holds now, which the query client may have shared structurally and so is not always the object handed in.
    remembered.push({ key, id, row, wrote: queryClient.getQueryData<MasterLesson[]>(key)?.[at] });
  }
  return remembered;
}

/** A lesson the gateway made: put in its year's list, once. */
export function addLesson(queryClient: QueryClient, lesson: MasterLesson): void {
  for (const [key, lessons] of yearLists(queryClient)) {
    if (key[1] !== lesson.academicYearId) continue;
    if (lessons.some((held) => held.id === lesson.id)) continue;
    queryClient.setQueryData(key, [...lessons, lesson]);
  }
}

/** A lesson the gateway removed: out of every list, and what the lists held of it. */
export function removeLesson(queryClient: QueryClient, id: string): Remembered {
  const remembered: Remembered = [];
  for (const [key, lessons] of yearLists(queryClient)) {
    const row = lessons.find((lesson) => lesson.id === id);
    if (!row) continue;
    remembered.push({ key, id, row });
    queryClient.setQueryData(
      key,
      lessons.filter((lesson) => lesson.id !== id),
    );
  }
  return remembered;
}

/**
 * Gives back what a refused write changed, lesson by lesson. Not the whole list:
 * another write may have changed another lesson since, and a list put back as it
 * was would take that with it.
 */
export function putBack(queryClient: QueryClient, remembered: Remembered | undefined): void {
  for (const { key, id, row, wrote } of remembered ?? []) {
    const lessons = queryClient.getQueryData<MasterLesson[]>(key);
    if (!lessons || !row) continue;
    const at = lessons.findIndex((lesson) => lesson.id === id);
    if (at === -1) {
      queryClient.setQueryData(key, [...lessons, row]);
      continue;
    }
    // The lesson stands there, and is not what the write laid: a colleague's change was read since (readHeard), or the year was.
    // That is the lesson as the database holds it, and the refusal of this write does not change what somebody else did.
    if (lessons[at] !== wrote) continue;
    const next = lessons.slice();
    next[at] = row;
    queryClient.setQueryData(key, next);
  }
}

// ---------------------------------------------------------------------------
// What a write of a lesson does to the lists around it (the callbacks of lib/queries.ts)
// ---------------------------------------------------------------------------

type Kind = "update" | "create" | "delete";

/** What a write remembers between its being asked for and its being answered. */
interface Context {
  /** A read of the year was on its way, and was stopped: the write is followed by a read. */
  reading: boolean;
  before: Remembered;
}

/**
 * The write is asked for. An update moves the card at once and a delete takes it out; a create has no lesson yet, and
 * waits for its answer.
 */
export async function began(queryClient: QueryClient, kind: Kind, input: unknown): Promise<Context | undefined> {
  if (kind === "create") return undefined;
  const reading = await holdReadsOfTheYear(queryClient);
  if (kind === "delete") return { reading, before: removeLesson(queryClient, input as string) };
  const { id, ...body } = input as { id: string };
  return { reading, before: patchLesson(queryClient, id, lessonFieldsOf(body)) };
}

/**
 * The gateway said no: the lesson is back where it was (and only it), and the year is read, because what is put back is what
 * this write saw and not what the database holds. A second write of the same lesson that began on top of this one saw this one's
 * square, and a read this write stopped is brought back by nothing else.
 */
export function refused(queryClient: QueryClient, context: unknown): void {
  putBack(queryClient, (context as Context | undefined)?.before);
  void queryClient.invalidateQueries({ queryKey: ["masterLessons"] });
}

/**
 * The gateway answered. An update's answer is the lesson as it now stands, and is laid over what was asked for; a create's is
 * the lesson, and is put in its list. Says whether the year needs a read besides: if one was stopped on its way, or one is on its way that may have seen the week before this write.
 */
export function answered(
  queryClient: QueryClient,
  kind: Kind,
  result: unknown,
  input: unknown,
  context: unknown,
): "read" | "keep" {
  // The answer is the lesson as the gateway held it when it was written, and a later write of the same lesson that is still on its
  // way has put the card where that one asks: laying this answer over it would show the card on the earlier square until the
  // later one is answered. That answer will lay itself.
  const id = (input as { id?: string } | undefined)?.id;
  const laterOnItsWay =
    kind === "update" &&
    queryClient
      .getMutationCache()
      .findAll({ predicate: (mutation) => mutation.state.status === "pending" && (mutation.state.variables as { id?: string } | undefined)?.id === id })
      .length > 1;
  if (kind === "update" && !laterOnItsWay) patchLesson(queryClient, (input as { id: string }).id, lessonFieldsOf(result as object));
  if (kind === "create") addLesson(queryClient, { fromPlacement: false, ...(result as object) } as unknown as MasterLesson);
  // A read that is on its way now began after this write was asked for, and the gateway announces a change to the school
  // (this writer's own socket too) before it commits it: that read may have seen the week as it was, and lands after what has
  // just been put in. It is begun again, after the commit.
  return (context as Context | undefined)?.reading || yearIsBeingRead(queryClient) ? "read" : "keep";
}

// ---------------------------------------------------------------------------
// A collaborator's change (lib/use-timetable-realtime.ts)
// ---------------------------------------------------------------------------

/**
 * The columns of a lesson the year's list reads, with its extra groups and its pupils. The same string as
 * `useMasterLessons` in lib/queries.ts reads, which cannot import this module (it would then be part of every route
 * that shares that one, which is what loading this module late is for): a contract test holds the two equal.
 */
export const MASTER_LESSON_SELECT =
  "id, academicYearId, subjectId, studentGroupId, teacherId, coTeacherId, roomId, dayOfWeek, startTime, endTime, isLocked, isParked, fromPlacement, isGenerated, exemptFrom, recurrence, startDate, endDate, extraGroups:MasterLessonGroups(studentGroupId), participants:MasterLessonStudents(studentId)";

type LessonRow = Omit<MasterLesson, "extraGroupIds" | "studentIds"> & {
  extraGroups: Array<{ studentGroupId: string }>;
  participants: Array<{ studentId: string }>;
};

/** A row as the list holds it: the groups and the pupils as ids, as `useMasterLessons` lays them. */
export function lessonOfRow({ extraGroups, participants, ...lesson }: LessonRow): MasterLesson {
  return {
    ...lesson,
    extraGroupIds: extraGroups.map((entry) => entry.studentGroupId),
    studentIds: participants.map((entry) => entry.studentId),
  };
}

/** A lesson as it now is, in its year's list: in the place it had, or at the end of it. */
export function putLesson(queryClient: QueryClient, lesson: MasterLesson): void {
  for (const [key, lessons] of yearLists(queryClient)) {
    if (key[1] !== lesson.academicYearId) continue;
    const at = lessons.findIndex((held) => held.id === lesson.id);
    if (at === -1) {
      queryClient.setQueryData(key, [...lessons, lesson]);
      continue;
    }
    const next = lessons.slice();
    next[at] = lesson;
    queryClient.setQueryData(key, next);
  }
}

/**
 * Somebody else changed these lessons: read just them, and lay what is there in the lists, and take out what is not (a lesson
 * somebody removed). The rows are read under this reader's own row-level security, as the year is, so the event gave nothing away.
 *
 * Says whether it did. False means the lists are to be read as before: no list is held to patch, the read failed, or a read of
 * the year is on its way (it began before this change and would land on top of it). Nothing is patched in those cases.
 */
export async function readHeard(
  queryClient: QueryClient,
  ids: readonly string[],
  current: (id: string) => boolean = () => true,
): Promise<boolean> {
  if (yearLists(queryClient).length === 0) return false;
  const { data, error } = await createClient().from("MasterLessons").select(MASTER_LESSON_SELECT).in("id", [...ids]);
  if (error || !Array.isArray(data)) return false;
  // A read of the year that began before this change would land on top of it, with the lessons as they stood when it
  // began, and nothing would mend them. The year is read again instead: the caller's invalidation stops the read on its
  // way and starts another.
  if (yearIsBeingRead(queryClient)) return false;
  const found = new Set<string>();
  for (const row of data as unknown as LessonRow[]) {
    found.add(row.id);
    // `current`: whether no later event has named the lesson since this read was asked for. A read that is answered after
    // the later one would put the lesson as it stood before.
    if (current(row.id)) putLesson(queryClient, lessonOfRow(row));
  }
  for (const id of ids) if (!found.has(id) && current(id)) removeLesson(queryClient, id);
  return true;
}

/**
 * One lesson as the database holds it now, laid in the lists that hold it: what a write that was refused for another's change
 * says the lesson has become (lib/lesson-changed.ts). Null is a lesson that is gone, and undefined a read that did not come.
 */
export async function readOne(queryClient: QueryClient, id: string): Promise<MasterLesson | null | undefined> {
  const { data, error } = await createClient().from("MasterLessons").select(MASTER_LESSON_SELECT).eq("id", id).maybeSingle();
  if (error) return undefined;
  if (!data) {
    removeLesson(queryClient, id);
    return null;
  }
  const lesson = lessonOfRow(data as unknown as LessonRow);
  putLesson(queryClient, lesson);
  return lesson;
}
