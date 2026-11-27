import { api } from "@/lib/api";
import type { BrickSubject } from "@/lib/board-tray";

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

/** The numbered time at a start, when it is one of the best. */
export function optionAt(times: PossibleTimes, dayOfWeek: number, startMinutes: number): PossibleOption | null {
  return times.options.find((option) => option.dayOfWeek === dayOfWeek && option.startMinutes === startMinutes) ?? null;
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

