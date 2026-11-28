import { api } from "@/lib/api";
import type { BrickSubject } from "@/lib/board-tray";
import { possibleOf, releasedOf } from "@/lib/possible-store";

/*
 * MÖJLIGA TIDER, AS THE BOARD READS THEM (E3).
 *
 * POST /api/v1/master-lessons/possible-times (src/calendar/possible-times.ts) answers where a lesson can stand: every start of the week
 * gets one answer, cut into runs per day, and the best times come with a rank. The board paints the runs behind the lessons while a
 * lesson is in hand (components/schedule/possible-layer.tsx) and the keyboard layer reads them to say why a square is or is not
 * possible (components/schedule/board-keys.tsx). The judge is the gateway's: nothing here decides what may stand, it only reads what
 * the gateway has already judged.
 */

export type PossibleKind = "FREE" | "CHANGE" | "CLOSED" | "IN_THE_WAY" | "CROWDED" | "STANDS";
export type ClosedCode = "FRAME" | "LUNCH" | "GRADE_RULE" | "OTHER_SCHOOL" | "AVAILABILITY";

/** One stretch of start times with one answer: the first start and the last (inclusive), `stepMinutes` apart. */
export interface PossibleRun {
  dayOfWeek: number;
  fromMinutes: number;
  toMinutes: number;
  kind: PossibleKind;
  code?: ClosedCode;
  params?: Record<string, string | number>;
  /** CHANGE: the room each lesson that has to stand in another than its own is free in, as the gateway's judge let it through. */
  rooms?: Array<{ lessonId: string; roomId: string | null }>;
  blockerId?: string;
  units?: number;
  locked?: boolean;
}

export interface PossibleCost {
  code: string;
  unit: string;
  before: number;
  after: number;
  delta: number;
}

export interface PossibleOption {
  /** 1 is the best. */
  rank: number;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  lessons: Array<{ lessonId: string; roomId: string | null; startMinutes: number; endMinutes: number }>;
  roomChanged: boolean;
  costs: PossibleCost[];
  wishes: { met: number; avoided: number };
  score: number;
}

export interface PossibleBlocker {
  lessonId: string;
  className: string;
  subjectName: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  isLocked: boolean;
}

export interface PossibleTimes {
  academicYearId: string;
  subject: {
    lessonId: string | null;
    className: string;
    subjectName: string;
    minutes: number;
    lessonIds: string[];
    isLocked: boolean;
    unplaced: boolean;
    current: { dayOfWeek: number; startMinutes: number; endMinutes: number } | null;
  };
  immovable?: "PLACED";
  stepMinutes: number;
  options: PossibleOption[];
  days: Array<{ dayOfWeek: number; runs: PossibleRun[] }>;
  blockers: Record<string, PossibleBlocker>;
}

/** How many of the best times are numbered: one key each, 1 to 9. */
export const NUMBERED = 9;

/**
 * What the question is about: a lesson that exists (its id), or a brick of Att lägga that is no lesson yet (what is known of it,
 * lib/board-tray.ts brickSubject). The gateway takes exactly one of them.
 */
export type PossibleSubject = string | BrickSubject;
const subjectBody = (subject: PossibleSubject) => (typeof subject === "string" ? { lessonId: subject } : { brick: subject });

/** Asks where a lesson (or a brick) can stand, the whole of the board's day, in five-minute steps. */
export function askPossibleTimes(subject: PossibleSubject, signal?: AbortSignal): Promise<PossibleTimes> {
  return api.post<PossibleTimes>(
    "/api/v1/master-lessons/possible-times",
    { ...subjectBody(subject), from: "07:00", to: "18:00", stepMinutes: 5, limit: NUMBERED },
    signal,
  );
}

/** The answer for a start, or null when the run list has none for it (the lesson cannot start there at all). */
export function runAt(times: PossibleTimes, dayOfWeek: number, startMinutes: number): PossibleRun | null {
  const day = times.days.find((entry) => entry.dayOfWeek === dayOfWeek);
  return day?.runs.find((run) => run.fromMinutes <= startMinutes && startMinutes <= run.toMinutes) ?? null;
}

/*
 * WHAT THE DIALOG OF OTHER TIMES MAY OFFER (E3, granskaren g503 #503 L-3).
 *
 * After a drop the page refuses it offers the nearest times its own check lets through (handleInvalidDrop, page.tsx). The page's check
 * holds no lesson of another school and no room lent to one: it let through an hour the lesson's own room is lent out (80 of 4 945
 * offers in the fall file's worlds with a loan), and the save said no. The gateway's judge holds both, so what it paints "free" is asked
 * of it here and a start it does not call free is not offered. Nothing is offered that the page itself refuses: this narrows, never widens.
 */

/** How long the dialog waits for the gateway before it offers what the page's own check lets through, as it did before. */
export const OFFER_WAIT_MS = 2500;

/** Whether the lesson may start at a time: the gateway's answer for it, read as the dialog needs it (see above). */
export function letsStartAt(times: PossibleTimes): (dayOfWeek: number, startMinutes: number) => boolean {
  // The answer for a unit of several lessons (a block) is for the unit, and the dialog moves one lesson of it: nothing is judged here.
  if (times.subject.lessonIds.length > 1) return () => true;
  return (dayOfWeek, startMinutes) => {
    const run = runAt(times, dayOfWeek, startMinutes);
    // The square the lesson stands on is its own. A start the answer has no run for is one it did not judge. Everything else the judge
    // refuses (CLOSED, IN_THE_WAY, CROWDED), or lets through only in another room (CHANGE: the dialog moves the lesson in its own).
    return run === null || run.kind === "FREE" || run.kind === "STANDS";
  };
}

/**
 * The starts the gateway lets the lesson have: from the answer the board already holds for it (a lesson dragged was asked about), else
 * asked. With no answer in time, or an answer that is not the gateway's shape, every start: the save still says what it says.
 */
export async function startsTheGatewayLets(lessonId: string, waitMs = OFFER_WAIT_MS): Promise<(dayOfWeek: number, startMinutes: number) => boolean> {
  // Held, or held a moment ago: the page asks this a microtask after the drop, when the layer has been unmounted and has emptied the store.
  const held = possibleOf(lessonId) ?? releasedOf(lessonId);
  if (held) return letsStartAt(held);
  const asking = new AbortController();
  const timer = setTimeout(() => asking.abort(), waitMs);
  try {
    const times = await Promise.resolve().then(() => askPossibleTimes(lessonId, asking.signal));
    return times && Array.isArray(times.days) && Array.isArray(times.options) && times.subject ? letsStartAt(times) : () => true;
  } catch {
    return () => true;
  } finally {
    clearTimeout(timer);
  }
}

/** The numbered time at a start, when it is one of the best. */
export function optionAt(times: PossibleTimes, dayOfWeek: number, startMinutes: number): PossibleOption | null {
  return times.options.find((option) => option.dayOfWeek === dayOfWeek && option.startMinutes === startMinutes) ?? null;
}

/**
 * The room the gateway judged a lesson in at a start, when it is another than the lesson's own: from the numbered time there, else from
 * the run of "another room" that holds the start. Undefined when the lesson stands in its own room, and when the gateway has no answer.
 * Laying the lesson with this room is what lets a square that is free only in another room be laid at all.
 */
export function roomAt(times: PossibleTimes, lessonId: string, dayOfWeek: number, startMinutes: number): string | null | undefined {
  const key = ownKey(times, lessonId);
  const option = optionAt(times, dayOfWeek, startMinutes);
  if (option) return option.roomChanged ? (option.lessons.find((entry) => entry.lessonId === key)?.roomId ?? null) : undefined;
  const run = runAt(times, dayOfWeek, startMinutes);
  if (run?.kind !== "CHANGE") return undefined;
  return run.rooms?.find((entry) => entry.lessonId === key)?.roomId ?? undefined;
}

/**
 * What the answer calls the lesson in hand: its id, or the empty string for a brick. A brick is a lesson that does not exist yet (the
 * tray's, E4), so the answer has no id for it (`subject.lessonId` is null) and names its room in `options[].lessons` and `rooms` under "".
 * Asked with the brick's own id (the tray's), `roomAt` finds it all the same: the answer is for one unit and the unit is the brick.
 */
function ownKey(times: PossibleTimes, lessonId: string): string {
  return times.subject.lessonId === null ? "" : lessonId;
}

/** The time that key 1 to 9 stands for. */
export function optionNumbered(times: PossibleTimes, rank: number): PossibleOption | null {
  return times.options.find((option) => option.rank === rank) ?? null;
}

/** What laying the lesson at a time does to the week, in words: only what moves, and nothing when nothing does. */
export function costWords(option: PossibleOption): string[] {
  const figure = (code: string) => option.costs.find((cost) => cost.code === code)?.delta ?? 0;
  const words: string[] = [];
  const pupils = figure("PUPIL_GAPS");
  if (pupils < 0) words.push("pupilsBetter");
  if (pupils > 0) words.push("pupilsWorse");
  const teacher = figure("TEACHER_GAPS");
  if (teacher < 0) words.push("teacherLess");
  if (teacher > 0) words.push("teacherMore");
  if (figure("DISTRIBUTION") < 0) words.push("distributionBetter");
  if (figure("DISTRIBUTION") > 0) words.push("distributionWorse");
  if (figure("TEACHER_DAY") < 0) words.push("dayBetter");
  if (figure("TEACHER_DAY") > 0) words.push("dayWorse");
  if (option.wishes.met > 0) words.push("wishMet");
  if (option.wishes.avoided > 0) words.push("wishBroken");
  if (option.roomChanged) words.push("roomChanged");
  return words;
}

/** 09:05 from minutes. */
export const clockOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** A lesson standing in a room, as a refusal names one: by class, subject, day and clock. */
export interface RoomOccupant {
  lessonId: string;
  className: string;
  subjectName: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  isLocked: boolean;
}

/** One room of the school for a lesson laid at a time (src/calendar/room-choices.ts), in the order it should be looked at. */
export interface RoomChoice {
  roomId: string;
  name: string;
  capacity: number | null;
  needed: number;
  state: "FREE" | "BUSY" | "CLOSED";
  tooSmall: boolean;
  typeOk: boolean;
  sameTypeAsOwn: boolean;
  allowed: boolean;
  current: boolean;
  shared: boolean;
  /** 1 is the best of the free rooms that fit. */
  rank: number | null;
  occupant: RoomOccupant | null;
  occupants: number;
  closedBy: ClosedCode | null;
  closedParams: Record<string, string | number>;
}

export interface RoomChoices {
  academicYearId: string;
  lessonId: string | null;
  className: string;
  subjectName: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  immovable?: "PLACED";
  rooms: RoomChoice[];
}

/** Asks which rooms the lesson (or the brick) can have at a day and clock (POST /master-lessons/room-choices). */
export function askRoomChoices(subject: PossibleSubject, dayOfWeek: number, startTime: string, signal?: AbortSignal): Promise<RoomChoices> {
  return api.post<RoomChoices>("/api/v1/master-lessons/room-choices", { ...subjectBody(subject), dayOfWeek, startTime }, signal);
}

