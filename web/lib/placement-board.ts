import type { TimetableBand, TimetableLesson } from "@/components/schedule/timetable-grid";
import type {
  PlacementRecurrence,
  PlacementRefusalReason,
  RequirementPlacement,
} from "@/lib/requirement-placements";

/*
 * Förlägg i veckan: the year's förläggningar as the gateway's board answers
 * them (GET /teaching-requirements/placements/board), and the pure part of the
 * page that shows them — the filters, the figures and the cards of the grid.
 *
 * THE GATEWAY COUNTS, THE PAGE SHOWS. What a post has left is Generera's own
 * count, made on the server (optimization/post-demand.ts), so the figure here
 * is the figure Generera sends and nothing in this file re-derives it. What a
 * row's verdict is, is the judge's (placement-judge.ts). This file only sums,
 * filters and draws.
 *
 * No person is named by the gateway: a teacher is an id, and its name is the
 * page's, from the list of people it already reads. Dates are written by
 * Intl in the reader's language, never by useFormatter (the page tests mock
 * next-intl with useLocale and useTranslations only).
 */

/** Why none of a post's lessons can be placed. */
export type PostCannotPlace = "BLOCK";
/** Why none of a part's lessons can be placed. */
export type PartCannotPlace = "NO_TEACHER";

/** The judge's verdict on one row; `reason` and `params` only when it does not hold. */
export interface BoardVerdict {
  ok: boolean;
  reason?: PlacementRefusalReason;
  params?: Record<string, string | number>;
}

/** One förläggning of the year with its verdict, and when its post's list was last saved. */
export interface BoardPlacement extends RequirementPlacement {
  changedAt: string;
  verdict: BoardVerdict;
}

/** One (teacher, length) of a post's lessons, and what answers each of them. */
export interface BoardPart {
  teacherId: string | null;
  minutes: number;
  count: number;
  /** Answered by a lesson Generera keeps. */
  locked: number;
  /** Answered by a förläggning. */
  placed: number;
  /** Still to place: what Generera asks the engine for. */
  left: number;
  cannotPlace: PartCannotPlace | null;
}

export interface BoardPost {
  id: string;
  studentGroupId: string;
  subjectId: string;
  teacherId: string | null;
  recurrence: PlacementRecurrence;
  startDate: string | null;
  endDate: string | null;
  cannotPlace: PostCannotPlace | null;
  parts: BoardPart[];
}

/** A lesson the next Generera keeps, which the rows are held against. Ids only. */
export interface BoardKept {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  studentGroupId: string;
  extraGroupIds: string[];
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  recurrence: PlacementRecurrence;
  startDate: string | null;
  endDate: string | null;
  locked: boolean;
  generated: boolean;
}

/** A meal the school placed by hand: the only meals a row is held to. */
export interface BoardMeal {
  id: string;
  studentGroupId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  startDate: string | null;
  endDate: string | null;
}

export interface PlacementBoard {
  academicYearId: string;
  placements: BoardPlacement[];
  posts: BoardPost[];
  kept: BoardKept[];
  meals: BoardMeal[];
}

/** The figures of a post, summed over its parts. */
export function totalsOf(post: Pick<BoardPost, "parts">): { count: number; locked: number; placed: number; left: number } {
  return post.parts.reduce(
    (sum, part) => ({
      count: sum.count + part.count,
      locked: sum.locked + part.locked,
      placed: sum.placed + part.placed,
      left: sum.left + part.left,
    }),
    { count: 0, locked: 0, placed: 0, left: 0 },
  );
}

/** The year's figures: rows, the ones that no longer hold, and the lessons still to place. */
export function summaryOf(board: Pick<PlacementBoard, "placements" | "posts">): {
  rows: number;
  failing: number;
  placed: number;
  left: number;
} {
  const totals = board.posts.map(totalsOf);
  return {
    rows: board.placements.length,
    failing: board.placements.filter((row) => !row.verdict.ok).length,
    placed: totals.reduce((sum, total) => sum + total.placed, 0),
    left: totals.reduce((sum, total) => sum + total.left, 0),
  };
}

/** What the page filters by; an empty list is "all", as the grundschema's pickers have it. */
export interface BoardFilters {
  groups: readonly string[];
  teachers: readonly string[];
  rooms: readonly string[];
}

export const NO_FILTERS: BoardFilters = { groups: [], teachers: [], rooms: [] };

export const isFiltered = (filters: BoardFilters): boolean =>
  filters.groups.length > 0 || filters.teachers.length > 0 || filters.rooms.length > 0;

export interface VisibleBoard {
  posts: BoardPost[];
  placements: BoardPlacement[];
  kept: BoardKept[];
  meals: BoardMeal[];
}

/** Whose lesson a row is: its own teacher on a shared post, else the post's. */
export const teacherOfPlacement = (row: Pick<BoardPlacement, "teacherId">, post: Pick<BoardPost, "teacherId"> | undefined): string | null =>
  row.teacherId ?? post?.teacherId ?? null;

const picks = (list: readonly string[], id: string | null): boolean => list.length === 0 || (id !== null && list.includes(id));

/**
 * The board narrowed by class, teacher and room. A row belongs to its post's
 * class, to its lesson's teacher and to its room; a kept lesson to its class
 * and the classes it also has, its teacher or medlärare and its room. The
 * meals are the classes' and are shown only for a class that is picked
 * (the page draws them as bands, and a band for every class is a wall). A post
 * is shown when its class and a teacher of it are picked, and — when a room is
 * picked — when one of its rows stands in it.
 */
export function visibleBoard(board: PlacementBoard, filters: BoardFilters): VisibleBoard {
  const postById = new Map(board.posts.map((post) => [post.id, post]));
  const placements = board.placements.filter((row) => {
    const post = postById.get(row.requirementId);
    return (
      picks(filters.groups, post?.studentGroupId ?? null) &&
      picks(filters.teachers, teacherOfPlacement(row, post)) &&
      picks(filters.rooms, row.roomId)
    );
  });
  const roomed = new Set(placements.map((row) => row.requirementId));
  const posts = board.posts.filter(
    (post) =>
      picks(filters.groups, post.studentGroupId) &&
      (filters.teachers.length === 0 ||
        [post.teacherId, ...post.parts.map((part) => part.teacherId)].some((id) => picks(filters.teachers, id))) &&
      (filters.rooms.length === 0 || roomed.has(post.id)),
  );
  const kept = board.kept.filter(
    (lesson) =>
      (filters.groups.length === 0 || [lesson.studentGroupId, ...lesson.extraGroupIds].some((id) => filters.groups.includes(id))) &&
      (filters.teachers.length === 0 || picks(filters.teachers, lesson.teacherId) || picks(filters.teachers, lesson.coTeacherId)) &&
      picks(filters.rooms, lesson.roomId),
  );
  const meals = filters.groups.length === 0 ? [] : board.meals.filter((meal) => filters.groups.includes(meal.studentGroupId));
  return { posts, placements, kept, meals };
}

/** The names a card is written from; each is the page's own lookup, so no name is the gateway's. */
export interface CardNames {
  subject: (id: string) => { name: string; color: string | null | undefined } | undefined;
  group: (id: string) => string | undefined;
  /** "A. Ek". */
  teacher: (id: string | null) => string | undefined;
  room: (id: string | null) => string | undefined;
  /** The grid's short note for the weeks a lesson runs ("udda", "period"), or null for every week. */
  weeks: (lesson: { recurrence: PlacementRecurrence; startDate: string | null; endDate: string | null }) => string | null;
  color: (subjectId: string, color: string | null | undefined) => string;
  /** The note on a lesson Generera keeps: "i grundschemat". */
  keptNote: string;
}

export const placementCardId = (id: string): string => `placement:${id}`;
export const keptCardId = (id: string): string => `kept:${id}`;

const minutesOfClockText = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** The förläggningar as cards: a red ring on one that no longer holds, no padlock. */
export function placementCards(
  rows: readonly BoardPlacement[],
  posts: ReadonlyMap<string, BoardPost>,
  names: CardNames,
): TimetableLesson[] {
  return rows.map((row) => {
    const post = posts.get(row.requirementId);
    const subject = post ? names.subject(post.subjectId) : undefined;
    const teacher = names.teacher(teacherOfPlacement(row, post));
    const note = names.weeks({
      recurrence: row.recurrence,
      startDate: post?.startDate ?? null,
      endDate: post?.endDate ?? null,
    });
    return {
      id: placementCardId(row.id),
      dayOfWeek: row.dayOfWeek,
      startMinutes: minutesOfClockText(row.startTime),
      endMinutes: minutesOfClockText(row.endTime),
      title: subject?.name ?? "",
      subtitle: [post ? names.group(post.studentGroupId) : undefined, teacher].filter(Boolean).join(" · "),
      room: row.roomName,
      color: names.color(post?.subjectId ?? "", subject?.color),
      conflicted: !row.verdict.ok,
      ...(note ? { recurrenceNote: note } : {}),
    };
  });
}

/** The lessons Generera keeps as cards: a padlock and the note "i grundschemat". */
export function keptCards(lessons: readonly BoardKept[], names: CardNames): TimetableLesson[] {
  return lessons.map((lesson) => {
    const subject = names.subject(lesson.subjectId);
    const classes = [lesson.studentGroupId, ...lesson.extraGroupIds].map((id) => names.group(id)).filter(Boolean).join(" + ");
    const note = names.weeks(lesson);
    return {
      id: keptCardId(lesson.id),
      dayOfWeek: lesson.dayOfWeek,
      startMinutes: minutesOfClockText(lesson.startTime),
      endMinutes: minutesOfClockText(lesson.endTime),
      title: subject?.name ?? "",
      subtitle: [classes, names.teacher(lesson.teacherId)].filter(Boolean).join(" · "),
      room: names.room(lesson.roomId),
      color: names.color(lesson.subjectId, subject?.color),
      locked: true,
      recurrenceNote: [names.keptNote, note].filter(Boolean).join(" · "),
    };
  });
}

/** A meal the school placed by hand, as a band behind the cards. */
export function mealBands(meals: readonly BoardMeal[], label: (meal: BoardMeal) => string): TimetableBand[] {
  return meals.map((meal) => ({
    id: `meal:${meal.id}`,
    dayOfWeek: meal.dayOfWeek,
    startMinutes: minutesOfClockText(meal.startTime),
    endMinutes: minutesOfClockText(meal.endTime),
    label: label(meal),
    handPlaced: true,
  }));
}

/** A förläggning's day is 08:00 to 18:00 (placement-fit.ts), and the grid draws to the last hour it holds. */
export const DAY_END_MINUTES = 18 * 60;
const MARKER_MINUTES = 15;

/**
 * Strips at the end of the school day, to make the grid draw all of it. An
 * empty grid shows 08–16 and one with lessons ends at the hour of the last of
 * them, while a förläggning's day goes to 18:00. The grid is not changed for
 * this (it is the grundschema's, within a few hundred bytes of its budget), so
 * the day's end is drawn the way the grid draws what it has: as a muted,
 * dashed strip that opens nothing, the last quarter of the day. Needed only
 * when nothing else reaches past 17:00.
 */
export function dayEndMarkers(reach: number, text: { title: string; line: string }): TimetableLesson[] {
  if (reach > DAY_END_MINUTES - 60) return [];
  return [1, 2, 3, 4, 5].map((dayOfWeek) => ({
    id: `day-end:${dayOfWeek}`,
    dayOfWeek,
    startMinutes: DAY_END_MINUTES - MARKER_MINUTES,
    endMinutes: DAY_END_MINUTES,
    // The grid says a duty's title to a screen reader only, and its line to the eye.
    title: text.title,
    subtitle: text.line,
    color: "#6b7280",
    duty: true,
    relieved: true,
  }));
}

/** How far down the day the cards reach: the end of the last of them, in minutes. */
export const reachOf = (cards: readonly Pick<TimetableLesson, "endMinutes">[]): number =>
  cards.reduce((end, card) => Math.max(end, card.endMinutes), 0);

/** When a list was saved, as a reader says it: "13 nov. 14:05", in the school's zone. */
export function savedAt(instant: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Stockholm",
  }).format(new Date(instant));
}

/** A day of the läsår as a school reads it: "24 aug. 2026". Read in UTC, as it was written. */
export function weekDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}
